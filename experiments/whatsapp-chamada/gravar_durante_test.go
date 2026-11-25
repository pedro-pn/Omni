package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Liga e pausa a gravação durante a ligação: ligar exige permissão e aviso; o trecho pausado
// não entra; a ligação continua "com gravação" mesmo pausada no fim (o Omni guarda o arquivo).
func TestGravarEPausarDuranteALigacao(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan nativeEvent, 32)
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
	b := nativeIdentity{NumberID: "22222222-1111-4111-8111-111111111111", OwnerID: "22222222-2222-4111-8111-111111111111", Phone: "5511987654322", CanRecord: true}
	request := func(i nativeIdentity, action, id string, record, notified bool) int {
		t.Helper()
		data, _ := json.Marshal(map[string]any{"numberId": i.NumberID, "ownerId": i.OwnerID, "phone": i.Phone, "canRecord": i.CanRecord, "action": action, "id": id, "record": record, "notified": notified, "peer": "5511999990000"})
		req, _ := http.NewRequest("POST", server.URL+"/internal/control", bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+cfg.omniKey)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		return response.StatusCode
	}
	if request(b, "connect", "", false, false) != 200 {
		t.Fatal("conexão recusada")
	}
	deadline := time.Now().Add(time.Second)
	var line *nativeLine
	for time.Now().Before(deadline) {
		manager.mu.Lock()
		line = manager.lines[b.NumberID]
		ready := line.app.snapshot()["connection"].(connection).State == "conectado"
		manager.mu.Unlock()
		if ready {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	line.app.mu.Lock()
	line.app.audioAttached = true
	line.app.mu.Unlock()
	if request(b, "dial", "", false, true) != 200 {
		t.Fatal("ligação recusada")
	}
	line.app.mu.Lock()
	s := line.app.current
	line.app.mu.Unlock()
	line.app.phase(s, "ativa")
	id := s.info.ID
	frame := make([]float32, frameSamples)
	for i := range frame {
		frame[i] = .25
	}
	// Sem gravação: nada entra.
	_ = s.media.WriteFrame(frame)
	// Ligar sem confirmar o aviso: recusado. Com o aviso: grava.
	if request(b, "record", id, true, false) != 403 {
		t.Fatal("gravou sem confirmar o aviso")
	}
	if request(b, "record", "ffffffffffffffffffffffffffffffff", true, true) != 409 {
		t.Fatal("aceitou gravar outra ligação")
	}
	if request(b, "record", id, true, true) != 200 || !s.info.RecordingActive || !s.info.Recording {
		t.Fatal("não começou a gravar durante a ligação")
	}
	time.Sleep(30 * time.Millisecond)
	_ = s.media.WriteFrame(frame)
	// Pausar: continua "com gravação", mas não grava agora.
	if request(b, "record", id, false, false) != 200 || s.info.RecordingActive || !s.info.Recording {
		t.Fatal("pausa não funcionou")
	}
	line.app.end("teste", false, id)
	line.app.mu.Lock()
	fim := line.app.records[0]
	line.app.mu.Unlock()
	if !fim.Recording || !fim.Audio {
		t.Fatal("a gravação feita durante a ligação se perdeu ao terminar pausada")
	}
	// O Omni foi avisado da gravação ligada (para guardar o arquivo).
	viu := false
	for len(events) > 0 {
		if e := <-events; e.Info.Recording {
			viu = true
		}
	}
	if !viu {
		t.Fatal("o Omni não soube da gravação ligada durante a ligação")
	}
}
