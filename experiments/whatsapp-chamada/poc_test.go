package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func testApp(t *testing.T) *app {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	a, err := newApp(ctx, config{mode: "simulado", dataDir: t.TempDir(), allowed: map[string]bool{}, maxDuration: time.Minute, retention: 24 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); a.close() })
	return a
}

func TestStereoRecordingPreservesBothSidesAndSilence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "both.wav")
	r, err := newRecorder(path, 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	r.start()
	mic, peer := make([]float32, frameSamples), make([]float32, frameSamples)
	for i := range mic {
		mic[i] = .25
		peer[i] = -.5
	}
	r.write(0, mic)
	r.write(1, peer)
	r.write(0, mic)
	frames, err := r.close()
	if err != nil {
		t.Fatal(err)
	}
	if frames != 2*frameSamples {
		t.Fatalf("frames = %d", frames)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data[:4]) != "RIFF" || binary.LittleEndian.Uint16(data[22:24]) != 2 || binary.LittleEndian.Uint32(data[24:28]) != sampleRate || int(binary.LittleEndian.Uint32(data[40:44])) != len(data)-44 {
		t.Fatal("cabeçalho WAV inválido")
	}
	if int16(binary.LittleEndian.Uint16(data[44:46])) != 8192 || int16(binary.LittleEndian.Uint16(data[46:48])) != -16384 {
		t.Fatal("canais não preservados")
	}
	if binary.LittleEndian.Uint16(data[44+frameSamples*4+2:]) != 0 {
		t.Fatal("canal remoto sem dados precisa conter silêncio")
	}
	if _, err = r.close(); err != nil {
		t.Fatal(err)
	}
}

func TestAudioBridgeBoundedQueueAndInvalidFrames(t *testing.T) {
	r, err := newRecorder(filepath.Join(t.TempDir(), "audio.wav"), 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	b := newAudioBridge(r)
	b.start()
	defer r.close()
	if b.pushPCM([]byte{1}) == nil {
		t.Fatal("aceitou áudio malformado")
	}
	frame := make([]byte, frameSamples*2)
	for i := 0; i < 20; i++ {
		_ = b.pushPCM(frame)
	}
	if b.dropped.Load() != 15 {
		t.Fatal("fila não limitada")
	}
	for i := 0; i < 6; i++ {
		if _, err = b.ReadFrame(); err != nil {
			t.Fatal(err)
		}
	}
	_ = b.Close()
	if _, err = b.ReadFrame(); err != io.EOF {
		t.Fatal("fechamento não interrompe fonte")
	}
}

func TestConfigOnlyExplicitTestNumbersAndLoopback(t *testing.T) {
	for _, key := range []string{"CHAMADA_MODO", "CHAMADA_ESCUTAR", "CHAMADA_LINHA_TESTE", "CHAMADA_NUMEROS_TESTE", "CHAMADA_LIMITE_SEGUNDOS", "CHAMADA_RETENCAO_HORAS", "CHAMADA_EVOLUTION_URL", "CHAMADA_EVOLUTION_KEY", "CHAMADA_EVOLUTION_INSTANCIA"} {
		t.Setenv(key, "")
	}
	c, err := loadConfig()
	if err != nil || c.mode != "simulado" {
		t.Fatal("padrão precisa ser simulado")
	}
	t.Setenv("CHAMADA_MODO", "teste")
	if _, err = loadConfig(); err == nil {
		t.Fatal("teste sem lista foi aceito")
	}
	t.Setenv("CHAMADA_LINHA_TESTE", "5547999990000")
	t.Setenv("CHAMADA_NUMEROS_TESTE", "5511999990000")
	if _, err = loadConfig(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHAMADA_ESCUTAR", "0.0.0.0:8096")
	if _, err = loadConfig(); err == nil {
		t.Fatal("escuta pública aceita")
	}
	t.Setenv("CHAMADA_ESCUTAR", "127.0.0.1:8096")
	t.Setenv("CHAMADA_LIMITE_SEGUNDOS", "600")
	if _, err = loadConfig(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHAMADA_LIMITE_SEGUNDOS", "601")
	if _, err = loadConfig(); err == nil {
		t.Fatal("limite excedido aceito")
	}
}

func localServer(t *testing.T, a *app) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	server.Config.Handler = a.handler(server.Listener.Addr().String())
	server.Start()
	t.Cleanup(server.Close)
	return server
}

func command(t *testing.T, server *httptest.Server, a *app, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", server.URL+"/api/control", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Omni-Chamada", "poc")
	req.Header.Set("Origin", server.URL)
	req.AddCookie(&http.Cookie{Name: "omni_chamada_poc", Value: a.token})
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func waitFor(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("estado esperado não chegou")
}

func TestBrowserAudioCallProducesTwoChannelRecording(t *testing.T) {
	a := testApp(t)
	a.simTone.Store(true) // Sinal remoto explícito para verificar os dois canais.
	server := localServer(t, a)
	a.setConnection(connection{State: "conectado"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	header := http.Header{"Origin": []string{server.URL}, "Cookie": []string{"omni_chamada_poc=" + a.token}}
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/audio", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	// Mantém o leitor ativo: o servidor também manda estados e áudio pelo socket.
	go func() {
		for {
			if _, _, err := ws.Read(ctx); err != nil {
				return
			}
		}
	}()
	response := command(t, server, a, `{"action":"dial","peer":"5511999990000","notified":true}`)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("dial = %d", response.StatusCode)
	}
	waitFor(t, func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return a.current != nil && a.current.info.State == "ativa"
	})
	frame := make([]byte, frameSamples*2)
	for i := 0; i < frameSamples; i++ {
		binary.LittleEndian.PutUint16(frame[2*i:], 8192)
	}
	for i := 0; i < 4; i++ {
		if err = ws.Write(ctx, websocket.MessageBinary, frame); err != nil {
			t.Fatal(err)
		}
		time.Sleep(65 * time.Millisecond)
	}
	a.mu.Lock()
	id := a.current.info.ID
	a.mu.Unlock()
	response = command(t, server, a, `{"action":"hangup","id":"`+id+`"}`)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	a.mu.Lock()
	record := a.records[0]
	a.mu.Unlock()
	if !record.Audio || record.MicFrames == 0 || record.PeerFrames == 0 || record.RecordingError {
		t.Fatalf("gravação incompleta: %+v", record)
	}
	data, err := os.ReadFile(filepath.Join(a.cfg.dataDir, id+".wav"))
	if err != nil {
		t.Fatal(err)
	}
	left, right := false, false
	for i := 44; i+3 < len(data); i += 4 {
		left = left || binary.LittleEndian.Uint16(data[i:]) != 0
		right = right || binary.LittleEndian.Uint16(data[i+2:]) != 0
	}
	if !left || !right {
		t.Fatal("um dos lados não foi gravado")
	}
	// Retoma o histórico após reiniciar o serviço, sem sessão WhatsApp.
	other, err := newApp(ctx, a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer other.close()
	if len(other.records) != 1 || !other.records[0].Audio {
		t.Fatal("histórico não persistiu")
	}
}

func TestSimulationQuietUntilToneIsEnabled(t *testing.T) {
	for _, direction := range []string{"saida", "entrada"} {
		t.Run(direction, func(t *testing.T) {
			a := testApp(t)
			a.setConnection(connection{State: "conectado"})
			a.audioAttached = true
			if direction == "saida" {
				if err := a.dial("5511999990000"); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := a.simulateIncoming(); err != nil {
					t.Fatal(err)
				}
				a.mu.Lock()
				id := a.current.info.ID
				a.mu.Unlock()
				if err := a.answer(id, true); err != nil {
					t.Fatal(err)
				}
			}
			waitFor(t, func() bool {
				a.mu.Lock()
				defer a.mu.Unlock()
				return a.current != nil && a.current.media.peerFrames.Load() >= 2
			})
			a.mu.Lock()
			s := a.current
			a.mu.Unlock()
			frame := <-s.media.playback
			if !bytes.Equal(frame, make([]byte, len(frame))) {
				t.Fatal("simulação gerou som sem solicitação")
			}
			server := localServer(t, a)
			response := command(t, server, a, `{"action":"test-tone","enabled":true}`)
			response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatalf("tom = %d", response.StatusCode)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			for {
				select {
				case <-ctx.Done():
					t.Fatal("tom solicitado não chegou")
				case frame := <-s.media.playback:
					if !bytes.Equal(frame, make([]byte, len(frame))) {
						return
					}
				}
			}
		})
	}
}

func TestSimulationToneFadesBackToSilence(t *testing.T) {
	tone := simulationTone{}
	frame := make([]float32, frameSamples)
	tone.fill(frame, true)
	var peak float32
	for _, sample := range frame {
		peak = max(peak, abs(sample))
	}
	if peak < .02 || peak > .031 {
		t.Fatalf("volume inesperado: %f", peak)
	}
	tone.fill(frame, false)
	for _, sample := range frame[160:] {
		if sample != 0 {
			t.Fatal("tom não voltou ao silêncio")
		}
	}
}

func abs(value float32) float32 {
	if value < 0 {
		return -value
	}
	return value
}

func TestLocalAPIRejectsForeignOriginAndMissingSession(t *testing.T) {
	a := testApp(t)
	server := localServer(t, a)
	response, err := server.Client().Get(server.URL + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("API pública")
	}
	req, _ := http.NewRequest("GET", server.URL+"/", nil)
	req.Header.Set("Origin", "https://other.invalid")
	response, err = server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("origem externa aceita")
	}
	response = command(t, server, a, `{"action":"dial","peer":"5511999990000"}`)
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatal("ligação sem aviso aceita")
	}
}

func TestEvolutionDiagnosticsOnlyReadsAndOmitsSecrets(t *testing.T) {
	var mu sync.Mutex
	paths := []string{}
	evo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.Header.Get("apikey") != "test-key" {
			t.Error("diagnóstico deve usar GET autenticado")
		}
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		switch r.URL.Path {
		case "/instance/fetchInstances":
			io.WriteString(w, `[{"name":"poc","connectionStatus":"open","ownerJid":"554799990000:3@s.whatsapp.net","apikey":"do-not-expose","_count":{"Message":42}}]`)
		case "/settings/find/poc":
			io.WriteString(w, `{"rejectCall":false}`)
		case "/webhook/find/poc":
			io.WriteString(w, `{"enabled":true,"url":"https://secret.invalid/hook","events":["MESSAGES_UPSERT"]}`)
		default:
			t.Error("rota inesperada")
			http.NotFound(w, r)
		}
	}))
	defer evo.Close()
	a := testApp(t)
	a.cfg.evolutionURL = evo.URL
	a.cfg.evolutionKey = "test-key"
	a.cfg.evolutionInstance = "poc"
	a.cfg.line = "5547999990000"
	report, err := a.diagnoseEvolution(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(a.snapshot())
	if bytes.Contains(data, []byte("test-key")) || bytes.Contains(data, []byte("do-not-expose")) || bytes.Contains(data, []byte("secret.invalid")) {
		t.Fatal("diagnóstico vazou segredo")
	}
	if !report.SameLine || report.RejectCall || report.Messages == nil || *report.Messages != 42 {
		t.Fatalf("diagnóstico incorreto: %+v", report)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(paths) != 3 {
		t.Fatalf("consultas = %v", paths)
	}
}

func TestAllowedNumbersAndStaleHangup(t *testing.T) {
	a := testApp(t)
	a.cfg.mode = "teste"
	a.cfg.allowed = map[string]bool{"5511999990000": true}
	a.setConnection(connection{State: "conectado"})
	a.audioAttached = true
	if err := a.dial("5511888880000"); err == nil {
		t.Fatal("número fora da lista aceito")
	}
	if err := a.dial("5511999990000"); err != nil {
		t.Fatal(err)
	}
	a.end("atrasado", false, randomID())
	a.mu.Lock()
	exists := a.current != nil
	a.mu.Unlock()
	if !exists {
		t.Fatal("comando de chamada antiga encerrou a atual")
	}
	if err := a.dial("5511999990000"); err == nil {
		t.Fatal("chamada simultânea aceita")
	}
}

func TestIncomingNeedsOperatorAcceptanceBeforeRecording(t *testing.T) {
	a := testApp(t)
	a.setConnection(connection{State: "conectado"})
	a.audioAttached = true
	if err := a.simulateIncoming(); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	s := a.current
	a.mu.Unlock()
	a.phase(s, "ativa") // preaccept ou evento antecipado nunca pode autorizar gravação.
	if s.info.StartedAt != nil || s.media.active.Load() || s.info.State != "recebendo" {
		t.Fatal("gravou antes de atender")
	}
	if err := a.answer(s.info.ID, false); err == nil {
		t.Fatal("atendeu sem aviso")
	}
	if err := a.answer(s.info.ID, true); err != nil {
		t.Fatal(err)
	}
	if !s.media.active.Load() {
		t.Fatal("áudio não iniciou depois do aceite")
	}
	if err := a.answer(s.info.ID, true); err == nil {
		t.Fatal("aceitou o mesmo atendimento duas vezes")
	}
}

func TestActiveCallStopsAtDurationLimit(t *testing.T) {
	a := testApp(t)
	a.cfg.maxDuration = 80 * time.Millisecond
	a.setConnection(connection{State: "conectado"})
	a.audioAttached = true
	if err := a.dial("5511999990000"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { a.mu.Lock(); defer a.mu.Unlock(); return len(a.records) == 1 })
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.current != nil || a.records[0].EndReason != "limite_de_duracao" {
		t.Fatal("limite não encerrou a chamada")
	}
}

func TestRetentionDeletesCompletedFiles(t *testing.T) {
	a := testApp(t)
	a.cfg.retention = time.Hour
	a.setConnection(connection{State: "conectado"})
	a.audioAttached = true
	if err := a.simulateIncoming(); err != nil {
		t.Fatal(err)
	}
	a.end("teste", true, "")
	past := time.Now().Add(-2 * time.Hour)
	a.mu.Lock()
	id := a.records[0].ID
	a.records[0].EndedAt = &past
	a.mu.Unlock()
	a.expireRecords()
	for _, ext := range []string{".json", ".wav"} {
		if _, err := os.Stat(filepath.Join(a.cfg.dataDir, id+ext)); !os.IsNotExist(err) {
			t.Fatal("arquivo expirado permaneceu")
		}
	}
}
