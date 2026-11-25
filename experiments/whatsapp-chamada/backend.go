package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"net/url"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	whatsmeow "github.com/polymorfa/hypermeow"
	"github.com/polymorfa/hypermeow/proto/waCompanionReg"
	"github.com/polymorfa/hypermeow/store"
	"github.com/polymorfa/hypermeow/store/sqlstore"
	"github.com/polymorfa/hypermeow/types"
	"github.com/polymorfa/hypermeow/types/events"
	waLog "github.com/polymorfa/hypermeow/util/log"
	meowcaller "github.com/purpshell/meowcaller"
	"github.com/rs/zerolog"
	qrcode "github.com/skip2/go-qrcode"
	_ "modernc.org/sqlite"
)

type realBackend struct {
	mu         sync.Mutex
	cfg        config
	wa         *whatsmeow.Client
	calls      *meowcaller.Client
	store      *sqlstore.Container
	connection func(connection)
	incoming   func(voiceCall)
}

func (b *realBackend) Connect(ctx context.Context) error {
	b.Close()
	store.SetOSInfo("Omni Chamadas POC", [3]uint32{0, 1, 0})
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_CHROME.Enum()
	b.connection(connection{State: "conectando"})
	path, err := filepath.Abs(filepath.Join(b.cfg.dataDir, "sessao.sqlite"))
	if err != nil {
		return err
	}
	dbURL := url.URL{Scheme: "file", Path: path}
	db, err := sqlstore.New(ctx, "sqlite", dbURL.String()+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)", waLog.Noop)
	if err != nil {
		return err
	}
	device, err := db.GetFirstDevice(ctx)
	if err != nil {
		db.Close()
		return err
	}
	wa := whatsmeow.NewClient(device, waLog.Noop)
	calls := meowcaller.NewClient(wa, meowcaller.WithLogger(zerolog.Nop()))
	b.mu.Lock()
	b.wa = wa
	b.calls = calls
	b.store = db
	b.mu.Unlock()
	calls.OnIncomingCall(func(c *meowcaller.Call) {
		if b.owns(wa) {
			b.incoming(&realCall{call: c, wa: wa})
		}
	})
	ready := make(chan error, 1)
	var authenticated, paired atomic.Bool
	fail := func(message string) {
		err := &connectionFailure{message: message}
		b.connection(connection{State: "erro", Message: message})
		select {
		case ready <- err:
		default:
		}
	}
	wa.AddEventHandler(func(event any) {
		if !b.owns(wa) {
			return
		}
		switch event := event.(type) {
		case *events.Connected:
			phone := wa.Store.GetJID().User
			if !samePhone(phone, b.cfg.line) {
				fail("O QR foi pareado com outra linha. Use o WhatsApp do número A configurado para este teste.")
				return
			}
			authenticated.Store(true)
			b.connection(connection{State: "conectado", Phone: b.cfg.line})
			select {
			case ready <- nil:
			default:
			}
		case *events.PairSuccess:
			paired.Store(true)
			if !samePhone(event.ID.User, b.cfg.line) {
				fail("O QR foi pareado com outra linha. Use o WhatsApp do número A configurado para este teste.")
				return
			}
			if !authenticated.Load() {
				b.connection(connection{State: "conectando", Message: "QR aceito. Finalizando a conexão com o WhatsApp."})
			}
		case *events.PairError:
			fail("O WhatsApp não concluiu o pareamento. Clique em Conectar linha e leia o novo QR pelo aparelho A.")
		case *events.ClientOutdated:
			fail("A versão de conexão foi recusada pelo WhatsApp. É necessário atualizar o conector antes de tentar novamente.")
		case *events.ConnectFailure:
			fail(fmt.Sprintf("O WhatsApp recusou a conexão (código %d). Tente conectar novamente.", event.Reason))
		case *events.LoggedOut:
			fail("O aparelho foi desvinculado no WhatsApp. Clique em Conectar linha para gerar outro QR.")
		case *events.Disconnected:
			if !authenticated.Load() {
				b.connection(connection{State: "conectando", Message: "Finalizando a conexão com o WhatsApp."})
				return
			}
			b.connection(connection{State: "desconectado", Message: "Conexão encerrada. Confira os aparelhos conectados e reconecte."})
		}
	})
	if device.ID == nil {
		qr, err := wa.GetQRChannel(ctx)
		if err != nil {
			b.Close()
			return err
		}
		if err = wa.Connect(); err != nil {
			b.Close()
			return err
		}
		go func() {
			for item := range qr {
				if !b.owns(wa) || authenticated.Load() {
					return
				}
				if item.Event == "code" {
					png, err := qrcode.Encode(item.Code, qrcode.Medium, 300)
					if err == nil {
						b.connection(connection{State: "pareando", QR: "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)})
					}
				} else {
					switch item.Event {
					case "success": // PairSuccess já atualiza a tela; Connected confirma o login.
					case "timeout":
						if !paired.Load() {
							fail("O QR expirou antes de concluir o pareamento. Clique em Conectar linha para gerar outro.")
						}
					case "err-client-outdated":
						fail("A versão de conexão foi recusada pelo WhatsApp. É necessário atualizar o conector.")
					case "error", "err-scanned-without-multidevice":
						fail("O WhatsApp não concluiu o pareamento. Clique em Conectar linha e leia o novo QR pelo aparelho A.")
					}
				}
			}
		}()
	} else if err = wa.Connect(); err != nil {
		b.Close()
		return err
	}
	select {
	case err = <-ready:
	case <-ctx.Done():
		err = ctx.Err()
	}
	if err != nil {
		b.Close()
	}
	return err
}

func (b *realBackend) owns(wa *whatsmeow.Client) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.wa == wa
}

func (b *realBackend) Dial(ctx context.Context, peer string) (voiceCall, error) {
	b.mu.Lock()
	wa, calls := b.wa, b.calls
	b.mu.Unlock()
	if wa == nil || !wa.IsLoggedIn() || !samePhone(wa.Store.GetJID().User, b.cfg.line) || !b.cfg.allowsPeer(peer) {
		return nil, errors.New("linha indisponível")
	}
	c, err := calls.Call(ctx, peer)
	if err != nil {
		return nil, err
	}
	return &realCall{call: c, wa: wa}, nil
}

func (b *realBackend) Close() {
	b.mu.Lock()
	wa, db := b.wa, b.store
	b.wa = nil
	b.calls = nil
	b.store = nil
	b.mu.Unlock()
	if wa != nil {
		wa.Disconnect()
	}
	if db != nil {
		_ = db.Close()
	}
}

type realCall struct {
	call *meowcaller.Call
	wa   *whatsmeow.Client
}

func (c *realCall) ID() string { return c.call.ID() }
func (c *realCall) Peer() string {
	jid := c.call.Peer().ToNonAD()
	if jid.Server == types.HiddenUserServer {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		pn, err := c.wa.Store.LIDs.GetPNForLID(ctx, jid)
		if err != nil {
			return ""
		}
		jid = pn
	}
	if jid.Server != types.DefaultUserServer {
		return ""
	}
	return jid.User
}
func (c *realCall) Video() bool   { return c.call.IsVideo() }
func (c *realCall) Group() bool   { _, group := c.call.GroupState(); return group }
func (c *realCall) Answer() error { return c.call.Answer() }
func (c *realCall) Reject() error { return c.call.Reject() }
func (c *realCall) Hangup() error { return c.call.Hangup() }
func (c *realCall) Bind(b *audioBridge, phase func(string), ended func()) {
	c.call.OnEnd(func(string) { ended() })
	// A POC só permite áudio individual, inclusive se alguém mudar o tipo da chamada.
	c.call.OnGroupState(func(meowcaller.GroupCallState) { go func() { _ = c.call.Hangup() }() })
	c.call.OnVideoState(func(meowcaller.VideoState) {
		if c.call.IsVideo() {
			go func() { _ = c.call.Hangup() }()
		}
	})
	update := func(p meowcaller.CallPhase) {
		switch p {
		case meowcaller.CallPhaseRinging:
			phase("tocando")
		case meowcaller.CallPhaseConnecting:
			phase("conectando")
		case meowcaller.CallPhaseActive:
			phase("ativa")
		case meowcaller.CallPhaseEnded:
			phase("encerrada")
		}
	}
	c.call.OnStateChange(update)
	c.call.OnReady(func() { phase("ativa") })
	c.call.Receive(b)
	c.call.Play(b)
	// Ringing é esperado na entrada; mantém o botão Atender até ação do operador.
	if c.call.State() != meowcaller.CallPhaseRinging {
		update(c.call.State())
	}
}

type simBackend struct {
	connection  func(connection)
	toneEnabled func() bool
}

func (b *simBackend) Connect(context.Context) error {
	b.connection(connection{State: "conectado", Phone: "simulador local"})
	return nil
}
func (b *simBackend) Dial(_ context.Context, peer string) (voiceCall, error) {
	return &simCall{id: randomID(), peer: peer, toneEnabled: b.toneEnabled}, nil
}
func (b *simBackend) Close() {}

type simCall struct {
	mu          sync.Mutex
	id, peer    string
	incoming    bool
	bridge      *audioBridge
	phase       func(string)
	ended       func()
	stop        chan struct{}
	once        sync.Once
	toneEnabled func() bool
}

func (c *simCall) ID() string   { return c.id }
func (c *simCall) Peer() string { return c.peer }
func (c *simCall) Video() bool  { return false }
func (c *simCall) Group() bool  { return false }
func (c *simCall) Bind(b *audioBridge, phase func(string), ended func()) {
	c.mu.Lock()
	c.bridge = b
	c.phase = phase
	c.ended = ended
	c.stop = make(chan struct{})
	incoming := c.incoming
	c.mu.Unlock()
	if !incoming {
		go func() {
			select {
			case <-time.After(350 * time.Millisecond):
				_ = c.Answer()
			case <-c.stop:
			}
		}()
	}
}
func (c *simCall) Answer() error {
	c.mu.Lock()
	phase, b, stop := c.phase, c.bridge, c.stop
	c.mu.Unlock()
	select {
	case <-stop:
		return nil
	default:
	}
	phase("ativa")
	go func() {
		ticker := time.NewTicker(60 * time.Millisecond)
		defer ticker.Stop()
		tone := simulationTone{}
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				frame, err := b.ReadFrame()
				if err != nil {
					return
				}
				// Silêncio por padrão. O sinal sintético só toca por escolha explícita.
				tone.fill(frame, c.toneEnabled != nil && c.toneEnabled())
				_ = b.WriteFrame(frame)
			}
		}
	}()
	return nil
}

type simulationTone struct {
	position  uint64
	amplitude float64
}

func (t *simulationTone) fill(frame []float32, enabled bool) {
	const volume = .03
	const step = volume / (sampleRate * .01) // entrada e saída suaves de 10 ms
	target := 0.0
	if enabled {
		target = volume
	}
	for i := range frame {
		t.amplitude += max(-step, min(step, target-t.amplitude))
		frame[i] = float32(t.amplitude * math.Sin(2*math.Pi*440*float64(t.position)/sampleRate))
		t.position++
	}
}
func (c *simCall) Reject() error { return c.Hangup() }
func (c *simCall) Hangup() error {
	c.once.Do(func() {
		c.mu.Lock()
		stop, end := c.stop, c.ended
		c.mu.Unlock()
		if stop != nil {
			close(stop)
		}
		if end != nil {
			end()
		}
	})
	return nil
}
