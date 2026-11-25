package main

import (
	"context"
	"errors"
	"os"
	"sync"

	whatsmeow "github.com/polymorfa/hypermeow"
	"github.com/polymorfa/hypermeow/proto/waAdv"
	"github.com/polymorfa/hypermeow/store"
	"github.com/polymorfa/hypermeow/types"
	waLog "github.com/polymorfa/hypermeow/util/log"
	"github.com/purpshell/meowcaller"
	"github.com/rs/zerolog"
	"google.golang.org/protobuf/proto"
)

type shadowBackend struct {
	cfg        config
	life       context.Context
	connection func(connection)
	incoming   func(voiceCall)
	mu         sync.Mutex
	relay      *shadowRelay
	wa         *whatsmeow.Client
	calls      *meowcaller.Client
}

type relaySnapshot struct {
	Version int    `json:"version"`
	Epoch   string `json:"epoch"`
	ID      string `json:"id"`
	LID     string `json:"lid"`
	Account []byte `json:"account"`
}

func (b *shadowBackend) Connect(ctx context.Context) error {
	b.Close()
	b.connection(connection{State: "conectando", Message: "Conectando ao pareamento da Evolution."})
	r, err := openShadowRelay(b.life, b.cfg.bridgeURL, b.cfg.bridgeToken)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			r.close()
		}
	}()
	var snapshot relaySnapshot
	if err = r.rpc(ctx, "snapshot", map[string]any{"line": b.cfg.line}, &snapshot); err != nil {
		return &connectionFailure{message: "A ponte está acessível, mas o número A precisa estar conectado na Evolution."}
	}
	device, err := b.seed(snapshot, r)
	if err != nil {
		return err
	}
	r.epoch = snapshot.Epoch
	waLogger, callLogger := waLog.Noop, zerolog.Nop()
	if diagnosticoLigado {
		// Só avisos e erros do cliente e do motor de chamadas (sem conteúdo de mensagens).
		waLogger = waLog.Stdout("wa", "WARN", false)
		callLogger = zerolog.New(os.Stderr).Level(zerolog.WarnLevel).With().Timestamp().Str("modulo", "meowcaller").Logger()
	}
	wa := whatsmeow.NewShadowClient(device, r, waLogger)
	calls := meowcaller.NewClient(wa, meowcaller.WithLogger(callLogger))
	calls.OnIncomingCall(func(c *meowcaller.Call) {
		b.mu.Lock()
		current := b.relay == r
		b.mu.Unlock()
		diag("motor: oferta decifrada de %s (relay atual: %v)", c.Peer().String(), current)
		if current {
			b.incoming(&realCall{call: c, wa: wa})
		}
	})
	b.mu.Lock()
	b.relay, b.wa, b.calls = r, wa, calls
	b.mu.Unlock()
	if err = r.rpc(ctx, "subscribe", nil, nil); err != nil {
		b.Close()
		return err
	}
	b.connection(connection{State: "conectado", Phone: b.cfg.line, Message: "Usando o pareamento da Evolution. Mensagens e chamadas na mesma sessão."})
	ok = true
	go b.receive(r, wa)
	return nil
}

func (b *shadowBackend) seed(snapshot relaySnapshot, r *shadowRelay) (*store.Device, error) {
	id, err := types.ParseJID(snapshot.ID)
	lid, lidErr := types.ParseJID(snapshot.LID)
	if err != nil || lidErr != nil || snapshot.Version != 1 || snapshot.Epoch == "" ||
		id.Server != types.DefaultUserServer || lid.Server != types.HiddenUserServer || lid.User == "" ||
		!samePhone(id.User, b.cfg.line) {
		return nil, &connectionFailure{message: "A ponte não está usando a linha A configurada ou tem uma versão incompatível."}
	}
	account := &waAdv.ADVSignedDeviceIdentity{}
	if proto.Unmarshal(snapshot.Account, account) != nil || len(account.GetDetails()) == 0 ||
		len(account.GetAccountSignature()) == 0 || len(account.GetDeviceSignature()) == 0 {
		return nil, errors.New("identidade pública indisponível")
	}
	// Somente identidade pública. Sem Noise, chave privada ou banco de sessões.
	return &store.Device{ID: &id, LID: lid, Account: account, Initialized: true, LIDs: &relayLIDStore{relay: r}}, nil
}

func (b *shadowBackend) receive(r *shadowRelay, wa *whatsmeow.Client) {
	defer func() {
		r.close()
		b.mu.Lock()
		current := b.relay == r
		if current {
			b.relay, b.wa, b.calls = nil, nil, nil
		}
		b.mu.Unlock()
		if current {
			b.connection(connection{State: "desconectado", Message: "A ponte foi desconectada. Aguarde a Evolution conectar e clique em Conectar linha."})
		}
	}()
	for {
		select {
		case <-r.ctx.Done():
			return
		case message := <-r.nodes:
			if message.Event != "node" || message.Epoch != r.epoch || message.Node == nil {
				diag("ponte: evento inesperado (%s, época confere: %v); a ponte será fechada", message.Event, message.Epoch == r.epoch)
				return
			}
			node, err := message.Node.node(0)
			if err != nil || (node.Tag != "call" && !(node.Tag == "ack" && node.AttrGetter().String("class") == "call")) {
				diag("ponte: nó inválido ou fora de chamada (%v); a ponte será fechada", err)
				return
			}
			filho := ""
			if kids := node.GetChildren(); len(kids) > 0 {
				filho = kids[0].Tag
			}
			diag("ponte: recebido %s/%s de %s", node.Tag, filho, node.AttrGetter().OptionalString("from"))
			if err := wa.InjectNode(r.ctx, &node); err != nil {
				diag("ponte: o motor recusou %s/%s (%v); a ponte será fechada", node.Tag, filho, err)
				return
			}
		}
	}
}

func (b *shadowBackend) Dial(ctx context.Context, peer string) (voiceCall, error) {
	b.mu.Lock()
	r, wa, calls := b.relay, b.wa, b.calls
	b.mu.Unlock()
	if r == nil || r.ctx.Err() != nil || !b.cfg.allowsPeer(peer) {
		return nil, errors.New("linha indisponível")
	}
	c, err := calls.Call(ctx, peer)
	if err != nil {
		return nil, err
	}
	return &realCall{call: c, wa: wa}, nil
}

func (b *shadowBackend) Close() {
	b.mu.Lock()
	r := b.relay
	b.relay, b.wa, b.calls = nil, nil, nil
	b.mu.Unlock()
	if r != nil {
		r.close()
	}
	// Não chama Disconnect, Logout, Connect nem Save na sessão da Evolution.
}
