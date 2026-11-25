package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

type nativeIdentity struct {
	NumberID  string `json:"numberId"`
	OwnerID   string `json:"ownerId"`
	Phone     string `json:"phone"`
	CanRecord bool   `json:"canRecord"`
}
type nativeLine struct {
	identity nativeIdentity
	app      *app
	ctl      sync.Mutex
	seen     time.Time
}
type audioTicket struct {
	line    *nativeLine
	expires time.Time
}
type nativeEvent struct {
	Identity nativeIdentity `json:"identity"`
	Info     callInfo       `json:"info"`
	Expires  time.Time      `json:"expires"`
}
type nativeManager struct {
	ctx     context.Context
	cfg     config
	mu      sync.Mutex
	lines   map[string]*nativeLine
	tickets map[string]audioTicket
	pending map[string]nativeEvent
	client  *http.Client
}

func newNativeManager(ctx context.Context, cfg config) *nativeManager {
	m := &nativeManager{ctx: ctx, cfg: cfg, lines: map[string]*nativeLine{}, tickets: map[string]audioTicket{}, pending: map[string]nativeEvent{},
		client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	// Metadados de linhas permitem reenviar eventos finais após um reinício;
	// nenhuma delas reconecta automaticamente ao WhatsApp.
	var catalog []nativeIdentity
	if data, err := os.ReadFile(filepath.Join(cfg.dataDir, "native-lines.json")); err == nil {
		_ = json.Unmarshal(data, &catalog)
	}
	for _, identity := range catalog {
		if m.valid(identity) {
			_, _ = m.ensure(identity)
		}
	}
	go m.sweep()
	return m
}
func (m *nativeManager) valid(i nativeIdentity) bool {
	return uuidPattern.MatchString(i.NumberID) && uuidPattern.MatchString(i.OwnerID) && phonePattern.MatchString(i.Phone)
}
func (m *nativeManager) ensure(i nativeIdentity) (*nativeLine, error) {
	if !m.valid(i) {
		return nil, errors.New("Linha inválida.")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if old := m.lines[i.NumberID]; old != nil {
		if old.identity.OwnerID == i.OwnerID && samePhone(old.identity.Phone, i.Phone) {
			old.seen = time.Now()
			old.identity.CanRecord = i.CanRecord
			if !i.CanRecord {
				old.app.mu.Lock()
				if s := old.app.current; s != nil {
					s.media.recorder.enable(false)
				}
				old.app.mu.Unlock()
			}
			return old, nil
		}
		// Uma troca de dono invalida a sessão antiga e os tickets já emitidos.
		go old.app.close()
		for token, t := range m.tickets {
			if t.line == old {
				delete(m.tickets, token)
			}
		}
	}
	cfg := m.cfg
	cfg.line = i.Phone
	cfg.dataDir = filepath.Join(cfg.dataDir, i.NumberID, i.OwnerID)
	if err := os.MkdirAll(cfg.dataDir, 0700); err != nil {
		return nil, err
	}
	a, err := newApp(m.ctx, cfg)
	if err != nil {
		return nil, err
	}
	line := &nativeLine{identity: i, app: a, seen: time.Now()}
	m.lines[i.NumberID] = line
	a.onInfo = func(info callInfo) error {
		event := nativeEvent{Identity: i, Info: info, Expires: info.CreatedAt.Add(cfg.retention)}
		if info.EndedAt == nil {
			return m.publish(event)
		}
		m.mu.Lock()
		m.pending[i.NumberID+info.ID] = event
		m.mu.Unlock()
		return nil
	}
	for _, info := range a.records {
		m.pending[i.NumberID+info.ID] = nativeEvent{Identity: i, Info: info, Expires: info.CreatedAt.Add(cfg.retention)}
	}
	catalog := make([]nativeIdentity, 0, len(m.lines))
	for _, l := range m.lines {
		catalog = append(catalog, l.identity)
	}
	data, _ := json.Marshal(catalog)
	path := filepath.Join(m.cfg.dataDir, "native-lines.json")
	if err := os.WriteFile(path+".tmp", data, 0600); err == nil {
		_ = os.Rename(path+".tmp", path)
	}
	return line, nil
}
func (m *nativeManager) publish(event nativeEvent) error {
	body, _ := json.Marshal(event)
	req, err := http.NewRequestWithContext(m.ctx, http.MethodPost, m.cfg.omniEvents, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.cfg.omniKey)
	req.Header.Set("Content-Type", "application/json")
	response, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return errors.New("Evento não registrado.")
	}
	return nil
}
func (m *nativeManager) sweep() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.mu.Lock()
			pending := make(map[string]nativeEvent, len(m.pending))
			for k, v := range m.pending {
				pending[k] = v
			}
			stale := []*nativeLine{}
			for _, l := range m.lines {
				if time.Since(l.seen) > 20*time.Second {
					stale = append(stale, l)
				}
			}
			for k, t := range m.tickets {
				if time.Now().After(t.expires) {
					delete(m.tickets, k)
				}
			}
			m.mu.Unlock()
			for _, l := range stale {
				l.ctl.Lock()
				m.mu.Lock()
				expired := time.Since(l.seen) > 20*time.Second
				m.mu.Unlock()
				if !expired {
					l.ctl.Unlock()
					continue
				}
				l.app.end("sessao_omni_expirada", false, "")
				l.app.backend.Close()
				l.app.setConnection(connection{State: "desconectado"})
				l.ctl.Unlock()
			}
			for k, event := range pending {
				if m.publish(event) == nil {
					m.mu.Lock()
					delete(m.pending, k)
					m.mu.Unlock()
				}
			}
		}
	}
}
func (m *nativeManager) close() {
	m.mu.Lock()
	lines := []*nativeLine{}
	for _, l := range m.lines {
		lines = append(lines, l)
	}
	m.mu.Unlock()
	for _, l := range lines {
		l.app.close()
	}
}

func (m *nativeManager) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, map[string]bool{"ok": true}) })
	mux.HandleFunc("GET /omni/audio", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != m.cfg.omniOrigin {
			apiError(w, 403, "Origem recusada.")
			return
		}
		m.mu.Lock()
		token := r.URL.Query().Get("ticket")
		ticket, ok := m.tickets[token]
		delete(m.tickets, token)
		valid := ok && time.Now().Before(ticket.expires) && m.lines[ticket.line.identity.NumberID] == ticket.line && time.Since(ticket.line.seen) < 20*time.Second
		m.mu.Unlock()
		if !valid {
			apiError(w, 401, "Áudio não autorizado.")
			return
		}
		ticket.line.app.handleAudio(w, r)
	})
	mux.HandleFunc("POST /internal/control", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			nativeIdentity
			Action   string `json:"action"`
			Peer     string `json:"peer"`
			ID       string `json:"id"`
			Record   bool   `json:"record"`
			Notified bool   `json:"notified"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil {
			apiError(w, 400, "Comando inválido.")
			return
		}
		line, err := m.ensure(input.nativeIdentity)
		if err != nil {
			apiError(w, 400, "Linha inválida.")
			return
		}
		line.ctl.Lock()
		defer line.ctl.Unlock()
		a := line.app
		record := input.Record && input.CanRecord
		if input.Record && (!input.CanRecord || !input.Notified) {
			apiError(w, 403, "Gravação não autorizada ou aviso não confirmado.")
			return
		}
		switch input.Action {
		case "status":
		case "connect":
			err = a.connect()
		case "disconnect":
			a.end("desconectada_pelo_usuario", false, "")
			a.backend.Close()
			a.setConnection(connection{State: "desconectado"})
		case "ticket":
			m.mu.Lock()
			if len(m.tickets) >= 256 {
				m.mu.Unlock()
				apiError(w, 429, "Aguarde antes de abrir outro áudio.")
				return
			}
			token := randomID() + randomID()
			m.tickets[token] = audioTicket{line: line, expires: time.Now().Add(30 * time.Second)}
			m.mu.Unlock()
			jsonResponse(w, 200, map[string]string{"ticket": token})
			return
		case "dial":
			a.mu.Lock()
			a.recordNext = record
			a.mu.Unlock()
			err = a.dial(input.Peer)
		case "incoming":
			err = a.simulateIncoming()
		case "answer":
			a.mu.Lock()
			s := a.current
			if s != nil && s.info.ID == input.ID && s.info.State == "recebendo" {
				s.info.Recording = record
				s.info.RecordingActive = record
				s.media.recorder.enable(record)
			}
			var info callInfo
			if s != nil {
				info = s.info
			}
			a.mu.Unlock()
			if s != nil && a.onInfo != nil {
				err = a.onInfo(info)
			}
			if err == nil {
				err = a.answer(input.ID, input.Notified)
			}
		case "record":
			// Liga ou pausa a gravação da ligação em andamento. Ligar exige a permissão e a
			// confirmação do aviso (conferidas acima); o trecho pausado fica em silêncio no arquivo.
			if !idPattern.MatchString(input.ID) {
				apiError(w, 400, "Chamada inválida.")
				return
			}
			a.mu.Lock()
			s := a.current
			ok := s != nil && s.info.ID == input.ID && !s.ending && s.info.State != "encerrada"
			var antes, info callInfo
			if ok {
				antes = s.info
				s.media.recorder.enable(record)
				s.info.RecordingActive = record
				s.info.Recording = s.info.Recording || record
				info = s.info
			}
			a.mu.Unlock()
			if !ok {
				apiError(w, 409, "A ligação não está mais em andamento.")
				return
			}
			if a.onInfo != nil {
				if err = a.onInfo(info); err != nil {
					// O Omni recusou (ex.: permissão retirada): volta como estava.
					a.mu.Lock()
					if a.current == s {
						s.media.recorder.enable(antes.RecordingActive)
						s.info.RecordingActive, s.info.Recording = antes.RecordingActive, antes.Recording
					}
					a.mu.Unlock()
				}
			}
		case "hangup", "reject":
			if !idPattern.MatchString(input.ID) {
				apiError(w, 400, "Chamada inválida.")
				return
			}
			a.end("encerrada_pelo_operador", input.Action == "reject", input.ID)
		default:
			apiError(w, 400, "Comando desconhecido.")
			return
		}
		if err != nil {
			apiError(w, 409, "Não foi possível concluir a ação. Confira a conexão, o microfone e o número permitido.")
			return
		}
		snapshot := a.snapshot()
		delete(snapshot, "records")
		delete(snapshot, "diagnostics")
		jsonResponse(w, 200, snapshot)
	})
	mux.HandleFunc("/internal/recordings/{number}/{owner}/{record}", func(w http.ResponseWriter, r *http.Request) {
		number, owner, id := r.PathValue("number"), r.PathValue("owner"), r.PathValue("record")
		if !uuidPattern.MatchString(number) || !uuidPattern.MatchString(owner) || !idPattern.MatchString(id) {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(m.cfg.dataDir, number, owner, id+".wav")
		if r.Method == http.MethodDelete {
			_ = os.Remove(path)
			jsonResponse(w, 200, map[string]bool{"ok": true})
			return
		}
		if r.Method != http.MethodGet {
			w.WriteHeader(405)
			return
		}
		source, err := os.Open(path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer source.Close()
		stat, err := source.Stat()
		if err != nil {
			http.NotFound(w, r)
			return
		}
		playback, err := recordingForPlayback(source, stat.Size())
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "audio/wav")
		http.ServeContent(w, r, "gravacao.wav", stat.ModTime(), playback)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if strings.HasPrefix(r.URL.Path, "/internal/") {
			got := []byte(r.Header.Get("Authorization"))
			want := []byte("Bearer " + m.cfg.omniKey)
			if r.Header.Get("Origin") != "" || len(got) != len(want) || subtle.ConstantTimeCompare(got, want) != 1 {
				apiError(w, 401, "Não autorizado.")
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}
