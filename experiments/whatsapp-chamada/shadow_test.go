package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	whatsmeow "github.com/polymorfa/hypermeow"
	waBinary "github.com/polymorfa/hypermeow/binary"
	"github.com/polymorfa/hypermeow/proto/waAdv"
	"github.com/polymorfa/hypermeow/types"
	waLog "github.com/polymorfa/hypermeow/util/log"
	"google.golang.org/protobuf/proto"
)

func TestRelayNodePreservesLIDAndBytes(t *testing.T) {
	from, _ := types.ParseJID("12345:3@lid")
	n := waBinary.Node{Tag: "call", Attrs: waBinary.Attrs{"from": from, "id": "abc"}, Content: []waBinary.Node{
		{Tag: "enc", Attrs: waBinary.Attrs{"v": "2", "type": "pkmsg"}, Content: []byte{0, 255, 128}},
	}}
	encoded, err := nodeToRelay(n)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(encoded)
	var decoded relayNode
	if err = json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	round, err := decoded.node(0)
	if err != nil || round.AttrGetter().JID("from") != from || !bytes.Equal(round.GetChildren()[0].Content.([]byte), []byte{0, 255, 128}) {
		t.Fatal("formato perdeu o JID ou os bytes")
	}
	both := relayNode{Tag: "x", Attrs: map[string]string{}, Data: new([]byte), Children: new([]relayNode)}
	if _, err = both.node(0); err == nil {
		t.Fatal("aceitou conteúdo ambíguo")
	}
}

func TestShadowSnapshotNeverSeedsPrivateKeys(t *testing.T) {
	account, _ := proto.Marshal(&waAdv.ADVSignedDeviceIdentity{Details: []byte{8, 1}, AccountSignature: make([]byte, 64), DeviceSignature: make([]byte, 64)})
	b := &shadowBackend{cfg: config{line: "5511987654300"}}
	snapshot := relaySnapshot{Version: 1, Epoch: "fixture", ID: "551187654300:3@s.whatsapp.net", LID: "12345:3@lid", Account: account}
	device, err := b.seed(snapshot, &shadowRelay{})
	if err != nil {
		t.Fatal(err)
	}
	if device.NoiseKey != nil || device.IdentityKey != nil || device.Sessions != nil || device.PreKeys != nil || device.Container != nil {
		t.Fatal("shadow importou estado privado")
	}
	wa := whatsmeow.NewShadowClient(device, &shadowRelay{}, waLog.Noop)
	if err := wa.Connect(); err != whatsmeow.ErrShadowClientNoConnect {
		t.Fatalf("shadow abriu socket: %v", err)
	}
	snapshot.ID = "551187654301:3@s.whatsapp.net"
	if _, err = b.seed(snapshot, &shadowRelay{}); err == nil {
		t.Fatal("aceitou outra linha")
	}
	snapshot.ID = "551187654300:3@s.whatsapp.net"
	snapshot.Version = 2
	if _, err = b.seed(snapshot, &shadowRelay{}); err == nil {
		t.Fatal("aceitou protocolo incompatível")
	}
}

func TestRelayDispatchDoesNotBlockRPCAndDisconnectCancelsPending(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer fixture" {
			t.Error("token ausente")
		}
		ws, err := websocket.Accept(w, request, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		for {
			_, data, err := ws.Read(request.Context())
			if err != nil {
				return
			}
			var m relayMessage
			_ = json.Unmarshal(data, &m)
			if m.Method == "blocked" {
				_ = ws.CloseNow()
				return
			}
			if m.Method == "nodeAndReply" {
				event, _ := json.Marshal(relayMessage{Event: "node", Epoch: "fixture", Node: &relayNode{Tag: "ack", Attrs: map[string]string{"class": "call"}}})
				_ = ws.Write(request.Context(), websocket.MessageText, event)
			}
			response, _ := json.Marshal(relayMessage{ID: m.ID, Result: json.RawMessage(`{}`)})
			_ = ws.Write(request.Context(), websocket.MessageText, response)
		}
	}))
	defer server.Close()
	r, err := openShadowRelay(context.Background(), strings.Replace(server.URL, "http", "ws", 1), "fixture")
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err = r.rpc(ctx, "nodeAndReply", nil, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-r.nodes:
	case <-ctx.Done():
		t.Fatal("evento não chegou")
	}
	if err = r.rpc(ctx, "blocked", nil, nil); err == nil {
		t.Fatal("queda não cancelou RPC")
	}
}

func TestBridgeConfigurationIsExplicitAndLocal(t *testing.T) {
	t.Setenv("CHAMADA_MODO", "teste")
	t.Setenv("CHAMADA_LINHA_TESTE", "5511987654321")
	t.Setenv("CHAMADA_NUMEROS_TESTE", "5511987654322")
	t.Setenv("CHAMADA_CONEXAO", "evolution")
	t.Setenv("CHAMADA_PONTE_TOKEN", strings.Repeat("x", 32))
	for _, address := range []string{"ws://external.invalid:8097/v1/calls", "ws://127.0.0.1:8097/other", "ws://user@127.0.0.1:8097/v1/calls", "ws://127.0.0.1:8097/v1/calls?key=secret"} {
		t.Setenv("CHAMADA_PONTE_URL", address)
		if _, err := loadConfig(); err == nil {
			t.Fatalf("aceitou endereço %s", address)
		}
	}
	t.Setenv("CHAMADA_PONTE_URL", "ws://127.0.0.1:8097/v1/calls")
	if _, err := loadConfig(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHAMADA_MODO", "simulado")
	if _, err := loadConfig(); err == nil {
		t.Fatal("ponte sem opt-in real")
	}
}

func TestShadowInteropWithBaileys(t *testing.T) {
	// Executado por evolution-bridge/test.sh; o servidor não possui rede externa,
	// sessões reais ou volumes da Evolution. Nunca use a URL da ponte real aqui.
	if os.Getenv("CHAMADA_INTEROP_FIXTURE") != "on" {
		t.Skip("fixture Node não iniciada")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	states := make(chan connection, 8)
	incoming := make(chan voiceCall, 1)
	b := &shadowBackend{life: ctx, cfg: config{line: "5511987654321", allowed: map[string]bool{"5511987654322": true},
		bridgeURL: "ws://127.0.0.1:19498/v1/calls", bridgeToken: strings.Repeat("fixture-only-", 4)}, connection: func(c connection) { states <- c }, incoming: func(c voiceCall) { incoming <- c }}
	defer b.Close()
	if err := b.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if b.wa.IsConnected() || b.wa.IsLoggedIn() {
		t.Fatal("shadow possui socket próprio")
	}
	if _, err := b.Dial(ctx, "5511987654399"); err == nil {
		t.Fatal("ligou fora da lista")
	}
	call, err := b.Dial(ctx, "5511987654322")
	if err != nil {
		t.Fatal(err)
	}
	raw := call.(*realCall)
	ended := make(chan struct{}, 1)
	raw.call.OnEnd(func(string) { ended <- struct{}{} })
	select {
	case <-ended:
	case <-ctx.Done():
		t.Fatal("evento de encerramento não chegou ao motor")
	}
	if err := b.relay.rpc(ctx, "resolveLID", map[string]any{"jid": "5511987654322@s.whatsapp.net"}, nil); err != nil {
		t.Fatal("injeção bloqueou o leitor RPC", err)
	}
	select {
	case call := <-incoming:
		if call.Peer() != "5511987654322" || call.Video() || call.Group() {
			t.Fatal("entrada perdeu a identidade ou o tipo")
		}
		if err := call.Reject(); err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("oferta recebida não chegou ao motor")
	}
}
