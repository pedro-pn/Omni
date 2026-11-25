package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type voiceCall interface {
	ID() string
	Peer() string
	Video() bool
	Group() bool
	Bind(*audioBridge, func(string), func())
	Answer() error
	Reject() error
	Hangup() error
}

type phoneBackend interface {
	Connect(context.Context) error
	Dial(context.Context, string) (voiceCall, error)
	Close()
}

type connection struct {
	State   string `json:"state"`
	Phone   string `json:"phone,omitempty"`
	QR      string `json:"qr,omitempty"`
	Message string `json:"message,omitempty"`
}

type callInfo struct {
	ID             string     `json:"id"`
	ProviderID     string     `json:"providerId,omitempty"`
	Peer           string     `json:"peer"`
	Direction      string     `json:"direction"`
	State          string     `json:"state"`
	Mode           string     `json:"mode"`
	CreatedAt      time.Time  `json:"createdAt"`
	StartedAt      *time.Time `json:"startedAt,omitempty"`
	EndedAt        *time.Time `json:"endedAt,omitempty"`
	EndReason      string     `json:"endReason,omitempty"`
	Audio          bool       `json:"audio"`
	MicFrames      uint64     `json:"micFrames"`
	PeerFrames     uint64     `json:"peerFrames"`
	Dropped        uint64     `json:"dropped"`
	RecordingError bool       `json:"recordingError"`
	// Recording: a ligação tem gravação (ficou ligada em algum momento; o Omni guarda o arquivo).
	Recording bool `json:"recording"`
	// RecordingActive: gravando agora (a pessoa pode pausar e retomar durante a ligação).
	RecordingActive bool `json:"recordingActive"`
}

type session struct {
	info     callInfo
	control  voiceCall
	media    *audioBridge
	timer    *time.Timer
	ending   bool
	accepted bool
}

type app struct {
	ctx           context.Context
	cfg           config
	mu            sync.Mutex
	opMu          sync.Mutex
	conn          connection
	current       *session
	backend       phoneBackend
	records       []callInfo
	audioAttached bool
	connecting    bool
	token         string
	diagnostics   []evolutionReport
	simTone       atomic.Bool
	recordNext    bool
	onInfo        func(callInfo) error
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("gerador aleatório indisponível")
	}
	return hex.EncodeToString(b[:])
}

func newApp(ctx context.Context, cfg config) (*app, error) {
	a := &app{ctx: ctx, cfg: cfg, token: randomID(), conn: connection{State: "desconectado"}, records: []callInfo{}, diagnostics: []evolutionReport{}}
	if err := a.loadRecords(); err != nil {
		return nil, err
	}
	if cfg.real() {
		if cfg.transport == "evolution" {
			a.backend = &shadowBackend{cfg: cfg, life: ctx, connection: a.setConnection, incoming: a.incoming}
		} else {
			a.backend = &realBackend{cfg: cfg, connection: a.setConnection, incoming: a.incoming}
		}
	} else {
		a.backend = &simBackend{connection: a.setConnection, toneEnabled: a.simTone.Load}
	}
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.expireRecords()
			}
		}
	}()
	return a, nil
}

func (a *app) setConnection(c connection) {
	a.mu.Lock()
	a.conn = c
	a.mu.Unlock()
	if c.State == "desconectado" || c.State == "erro" {
		go a.end("conexao_interrompida", false, "")
	}
}

func (a *app) connect() error {
	a.mu.Lock()
	if a.connecting || a.conn.State == "conectado" {
		a.mu.Unlock()
		return nil
	}
	a.connecting = true
	a.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(a.ctx, 3*time.Minute)
		defer cancel()
		err := a.backend.Connect(ctx)
		a.mu.Lock()
		a.connecting = false
		a.mu.Unlock()
		if err != nil {
			a.setConnection(connection{State: "erro", Message: connectionFailureMessage(err)})
		}
	}()
	return nil
}

func (a *app) reserve(peer, direction, state string) (*session, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.current != nil {
		return nil, errors.New("Já existe uma chamada em andamento.")
	}
	if a.conn.State != "conectado" {
		return nil, errors.New("Conecte a linha antes de ligar.")
	}
	if direction == "saida" && !a.audioAttached {
		return nil, errors.New("Ative o microfone antes de ligar.")
	}
	if a.cfg.real() && !a.cfg.allowsPeer(peer) {
		if a.cfg.mode == "producao" {
			return nil, errors.New("Número inválido para ligar.")
		}
		return nil, errors.New("Este número não está na lista de teste.")
	}
	id := randomID()
	recorder, err := newRecorder(filepath.Join(a.cfg.dataDir, id+".wav"), a.cfg.maxDuration)
	if err != nil {
		return nil, errors.New("Não foi possível preparar a gravação.")
	}
	record := !a.cfg.native || (direction == "saida" && a.recordNext)
	recorder.enable(record)
	s := &session{info: callInfo{ID: id, Peer: peer, Direction: direction, State: state, Mode: a.cfg.mode, Recording: record, RecordingActive: record, CreatedAt: time.Now().UTC()}, media: newAudioBridge(recorder)}
	if a.onInfo != nil {
		if err := a.onInfo(s.info); err != nil {
			_, _ = recorder.close()
			_ = os.Remove(filepath.Join(a.cfg.dataDir, id+".wav"))
			return nil, errors.New("Não foi possível registrar a chamada no Omni.")
		}
	}
	a.current = s
	s.timer = time.AfterFunc(45*time.Second, func() { a.end("tempo_sem_resposta", false, s.info.ID) })
	return s, nil
}

func (a *app) bind(s *session, c voiceCall) {
	a.mu.Lock()
	if a.current != s || s.ending {
		a.mu.Unlock()
		_ = c.Hangup()
		return
	}
	s.control = c
	s.info.ProviderID = c.ID()
	a.mu.Unlock()
	c.Bind(s.media, func(state string) { a.phase(s, state) }, func() { a.finish(s, "encerrada_pelo_whatsapp") })
}

func (a *app) dial(peer string) error {
	a.opMu.Lock()
	defer a.opMu.Unlock()
	if !phonePattern.MatchString(peer) {
		return errors.New("Informe o número com DDI, só dígitos.")
	}
	s, err := a.reserve(peer, "saida", "ligando")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	c, err := a.backend.Dial(ctx, peer)
	if err != nil {
		a.finish(s, "falha_ao_ligar")
		return errors.New("Não foi possível iniciar a chamada.")
	}
	a.bind(s, c)
	return nil
}

func (a *app) incoming(c voiceCall) {
	if !a.opMu.TryLock() {
		diag("chamada recebida ignorada: outra operação em andamento")
		return
	}
	defer a.opMu.Unlock()
	// Chamadas de outros contatos ficam no aparelho, sem rejeição automática global.
	if c.Video() || c.Group() || (a.cfg.real() && !a.cfg.allowsPeer(c.Peer())) {
		diag("chamada recebida ignorada: vídeo=%v grupo=%v número=%s permitido=%v", c.Video(), c.Group(), c.Peer(), a.cfg.allowsPeer(c.Peer()))
		return
	}
	s, err := a.reserve(c.Peer(), "entrada", "recebendo")
	if err != nil {
		diag("chamada recebida ignorada: não foi possível reservar (%v)", err)
		return
	}
	diag("chamada recebida registrada: %s", c.Peer())
	a.bind(s, c)
}

func (a *app) simulateIncoming() error {
	if a.cfg.mode != "simulado" {
		return errors.New("Disponível apenas no modo simulado.")
	}
	a.opMu.Lock()
	defer a.opMu.Unlock()
	s, err := a.reserve("5511999990000", "entrada", "recebendo")
	if err != nil {
		return err
	}
	a.bind(s, &simCall{id: randomID(), peer: s.info.Peer, incoming: true, toneEnabled: a.simTone.Load})
	return nil
}

func (a *app) answer(id string, notified bool) error {
	a.opMu.Lock()
	defer a.opMu.Unlock()
	a.mu.Lock()
	s := a.current
	if s == nil || s.info.ID != id || s.info.State != "recebendo" || s.accepted || s.control == nil {
		a.mu.Unlock()
		return errors.New("Não há chamada recebida para atender.")
	}
	if !a.audioAttached || (!notified && (!a.cfg.native || s.info.Recording)) {
		a.mu.Unlock()
		return errors.New("Ative o microfone e confirme o aviso da gravação.")
	}
	c := s.control
	s.accepted = true
	s.info.State = "conectando"
	a.mu.Unlock()
	if err := c.Answer(); err != nil {
		a.finish(s, "falha_ao_atender")
		_ = c.Hangup()
		return errors.New("Não foi possível atender.")
	}
	return nil
}

func (a *app) phase(s *session, state string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.current != s || s.ending {
		return
	}
	if state == "encerrada" {
		go a.finish(s, "encerrada_pelo_whatsapp")
		return
	}
	// Sinalização inicial do motor nunca substitui o aceite do operador.
	if s.info.Direction == "entrada" && !s.accepted {
		return
	}
	if state == "ativa" {
		if s.info.StartedAt == nil {
			now := time.Now().UTC()
			s.info.StartedAt = &now
			s.media.start()
			s.timer.Stop()
			s.timer = time.AfterFunc(a.cfg.maxDuration, func() { a.end("limite_de_duracao", false, s.info.ID) })
		}
	} else if s.info.StartedAt != nil {
		return
	} // evento atrasado não faz chamada ativa voltar para tocando.
	if state == "tocando" && s.info.Direction == "entrada" {
		state = "recebendo"
	}
	s.info.State = state
}

func (a *app) end(reason string, reject bool, id string) {
	a.opMu.Lock()
	defer a.opMu.Unlock()
	a.mu.Lock()
	s := a.current
	if s == nil || s.ending || (id != "" && s.info.ID != id) {
		a.mu.Unlock()
		return
	}
	c := s.control
	pending := s.info.Direction == "entrada" && s.info.StartedAt == nil
	a.mu.Unlock()
	// Finaliza primeiro: callback síncrono do motor pode chamar finish novamente.
	a.finish(s, reason)
	if c != nil {
		if reject {
			_ = c.Reject()
		} else if !pending {
			_ = c.Hangup()
		}
	}
}

func (a *app) finish(s *session, reason string) {
	a.mu.Lock()
	if a.current != s || s.ending {
		a.mu.Unlock()
		return
	}
	s.ending = true
	s.timer.Stop()
	a.mu.Unlock()
	_ = s.media.Close()
	frames, err := s.media.recorder.close()
	now := time.Now().UTC()
	info := s.info
	info.State = "encerrada"
	info.EndedAt = &now
	info.EndReason = reason
	info.Audio = frames > 0
	info.MicFrames = s.media.micFrames.Load()
	info.PeerFrames = s.media.peerFrames.Load()
	info.Dropped = s.media.dropped.Load()
	info.RecordingError = err != nil
	if err = a.saveRecord(info); err != nil {
		info.RecordingError = true
	}
	a.mu.Lock()
	a.records = append([]callInfo{info}, a.records...)
	a.current = nil
	a.mu.Unlock()
	if a.onInfo != nil {
		_ = a.onInfo(info)
	}
}

func (a *app) saveRecord(info callInfo) error {
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(a.cfg.dataDir, info.ID+".json")
	if err = os.WriteFile(path+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

func (a *app) loadRecords() error {
	entries, err := os.ReadDir(a.cfg.dataDir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(a.cfg.dataDir, e.Name()))
		if err != nil {
			return err
		}
		var info callInfo
		if json.Unmarshal(data, &info) != nil || !idPattern.MatchString(info.ID) || e.Name() != info.ID+".json" {
			continue
		}
		a.records = append(a.records, info)
	}
	sort.Slice(a.records, func(i, j int) bool { return a.records[i].CreatedAt.After(a.records[j].CreatedAt) })
	a.expireRecords()
	return nil
}

func (a *app) expireRecords() {
	a.mu.Lock()
	defer a.mu.Unlock()
	kept := a.records[:0]
	for _, r := range a.records {
		if r.EndedAt != nil && time.Since(*r.EndedAt) > a.cfg.retention {
			_ = os.Remove(filepath.Join(a.cfg.dataDir, r.ID+".wav"))
			_ = os.Remove(filepath.Join(a.cfg.dataDir, r.ID+".json"))
		} else {
			kept = append(kept, r)
		}
	}
	a.records = kept
}

func (a *app) deleteRecord(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i, r := range a.records {
		if r.ID != id {
			continue
		}
		for _, ext := range []string{".wav", ".json"} {
			if err := os.Remove(filepath.Join(a.cfg.dataDir, id+ext)); err != nil && !os.IsNotExist(err) {
				return errors.New("Não foi possível apagar a gravação.")
			}
		}
		a.records = append(a.records[:i], a.records[i+1:]...)
		return nil
	}
	return errors.New("Gravação não encontrada.")
}

func (a *app) snapshot() map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	var call *callInfo
	if s := a.current; s != nil {
		info := s.info
		info.MicFrames = s.media.micFrames.Load()
		info.PeerFrames = s.media.peerFrames.Load()
		info.Dropped = s.media.dropped.Load()
		call = &info
	}
	allowed := make([]string, 0, len(a.cfg.allowed))
	for p := range a.cfg.allowed {
		allowed = append(allowed, p)
	}
	sort.Strings(allowed)
	return map[string]any{"mode": a.cfg.mode, "transport": a.cfg.transport, "connection": a.conn, "call": call, "records": append([]callInfo{}, a.records...),
		"audioAttached": a.audioAttached, "testTone": a.simTone.Load(), "allowed": allowed, "line": a.cfg.line, "evolutionConfigured": a.cfg.evolutionURL != "",
		"diagnostics": append([]evolutionReport{}, a.diagnostics...), "maxSeconds": int(a.cfg.maxDuration.Seconds()), "retentionHours": int(a.cfg.retention.Hours())}
}

func (a *app) close() { a.end("servidor_encerrado", false, ""); a.backend.Close() }
