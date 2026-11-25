package main

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeLinesTicketsAndRecordingPermissions(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan nativeEvent, 16)
	webhook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var event nativeEvent
		_ = json.NewDecoder(r.Body).Decode(&event)
		events <- event
		w.WriteHeader(200)
	}))
	defer webhook.Close()
	cfg := config{native: true, mode: "simulado", dataDir: t.TempDir(), omniOrigin: "http://localhost:3001", omniKey: strings.Repeat("k", 64), omniEvents: webhook.URL, retention: time.Hour, maxDuration: time.Minute}
	manager := newNativeManager(ctx, cfg)
	defer manager.close()
	server := httptest.NewServer(manager.handler())
	defer server.Close()
	a := nativeIdentity{NumberID: "11111111-1111-4111-8111-111111111111", OwnerID: "11111111-2222-4111-8111-111111111111", Phone: "5511987654321"}
	b := nativeIdentity{NumberID: "22222222-1111-4111-8111-111111111111", OwnerID: "22222222-2222-4111-8111-111111111111", Phone: "5511987654322", CanRecord: true}
	request := func(i nativeIdentity, action string, record bool) (int, map[string]any) {
		t.Helper()
		input := map[string]any{"numberId": i.NumberID, "ownerId": i.OwnerID, "phone": i.Phone, "canRecord": i.CanRecord, "action": action, "record": record, "notified": true, "peer": "5511999990000"}
		data, _ := json.Marshal(input)
		req, _ := http.NewRequest("POST", server.URL+"/internal/control", bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+cfg.omniKey)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result map[string]any
		_ = json.NewDecoder(response.Body).Decode(&result)
		return response.StatusCode, result
	}
	res, err := http.Get(server.URL + "/internal/control")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal("API interna sem autenticação")
	}
	for _, i := range []nativeIdentity{a, b} {
		if status, _ := request(i, "connect", false); status != 200 {
			t.Fatal("conexão recusada")
		}
	}
	// O simulador conecta de modo assíncrono.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		manager.mu.Lock()
		ready := manager.lines[a.NumberID].app.snapshot()["connection"].(connection).State == "conectado" && manager.lines[b.NumberID].app.snapshot()["connection"].(connection).State == "conectado"
		manager.mu.Unlock()
		if ready {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if status, _ := request(a, "dial", true); status != 403 {
		t.Fatal("pessoa sem permissão gravou")
	}
	_, tokenA := request(a, "ticket", false)
	_, tokenB := request(b, "ticket", false)
	// Uma origem externa não consegue consumir o ticket. O ticket só abre a linha A.
	url := strings.Replace(server.URL, "http", "ws", 1) + "/omni/audio?ticket=" + tokenA["ticket"].(string)
	wrong, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"http://externo.invalid"}}})
	if err == nil {
		wrong.CloseNow()
		t.Fatal("origem externa aceita")
	}
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{cfg.omniOrigin}}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	audioCtx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		for {
			if _, _, err := ws.Read(audioCtx); err != nil {
				return
			}
		}
	}()
	manager.mu.Lock()
	lineA, lineB := manager.lines[a.NumberID], manager.lines[b.NumberID]
	manager.mu.Unlock()
	lineB.app.mu.Lock()
	attachedB := lineB.app.audioAttached
	lineB.app.mu.Unlock()
	if attachedB {
		t.Fatal("ticket de A abriu o áudio de B")
	}
	if status, _ := request(a, "dial", false); status != 200 {
		t.Fatal("ligação sem gravação recusada")
	}
	select {
	case event := <-events:
		if event.Identity.OwnerID != a.OwnerID || event.Info.Recording {
			t.Fatal("evento atravessou o dono ou gravou sem opção")
		}
	case <-time.After(time.Second):
		t.Fatal("evento não registrado")
	}
	if call := lineB.app.snapshot()["call"].(*callInfo); call != nil {
		t.Fatal("B recebeu o estado da chamada de A")
	}
	lineA.app.mu.Lock()
	session := lineA.app.current
	lineA.app.mu.Unlock()
	session.media.start()
	_ = session.media.WriteFrame(make([]float32, frameSamples))
	lineA.app.finish(session, "teste")
	lineA.app.mu.Lock()
	recorded := lineA.app.records[0]
	lineA.app.mu.Unlock()
	if recorded.Audio {
		t.Fatal("áudio foi salvo apesar de gravação desativada")
	}
	if replay, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{cfg.omniOrigin}}}); err == nil {
		replay.CloseNow()
		t.Fatal("ticket reutilizado")
	}
	if tokenA["ticket"] == tokenB["ticket"] {
		t.Fatal("tickets de pessoas diferentes iguais")
	}
	lineB.app.mu.Lock()
	lineB.app.audioAttached = true
	lineB.app.mu.Unlock()
	if status, _ := request(b, "dial", true); status != 200 {
		t.Fatal("gravação autorizada recusada")
	}
	lineB.app.mu.Lock()
	second := lineB.app.current
	lineB.app.mu.Unlock()
	lineB.app.phase(second, "ativa")
	frame := make([]float32, frameSamples)
	for i := range frame {
		frame[i] = .25
	}
	_ = second.media.WriteFrame(frame)
	lineB.app.end("teste", false, second.info.ID)
	lineB.app.mu.Lock()
	captured := lineB.app.records[0]
	lineB.app.mu.Unlock()
	if !captured.Audio || !captured.Recording {
		t.Fatal("gravação opt-in não foi preservada")
	}
	// A troca de dono invalida tickets antigos e não transfere o diretório.
	_, oldToken := request(b, "ticket", false)
	b.OwnerID = "33333333-2222-4111-8111-111111111111"
	_, _ = request(b, "status", false)
	manager.mu.Lock()
	_, stillValid := manager.tickets[oldToken["ticket"].(string)]
	newPath := manager.lines[b.NumberID].app.cfg.dataDir
	manager.mu.Unlock()
	if stillValid || newPath != filepath.Join(cfg.dataDir, b.NumberID, b.OwnerID) {
		t.Fatal("troca de dono transferiu mídia ou ticket")
	}
}
