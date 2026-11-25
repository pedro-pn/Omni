package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

// Configuração base válida do modo produção (dentro do compose).
func producaoEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"CHAMADA_LINHA_TESTE", "CHAMADA_NUMEROS_TESTE", "CHAMADA_LIMITE_SEGUNDOS", "CHAMADA_RETENCAO_HORAS", "CHAMADA_EVOLUTION_URL", "CHAMADA_EVOLUTION_KEY", "CHAMADA_EVOLUTION_INSTANCIA"} {
		t.Setenv(key, "")
	}
	t.Setenv("CHAMADA_MODO", "producao")
	t.Setenv("CHAMADA_OMNI", "on")
	t.Setenv("CHAMADA_CONEXAO", "evolution")
	t.Setenv("CHAMADA_ESCUTAR", "0.0.0.0:8098")
	t.Setenv("CHAMADA_ESCUTAR_AUDIO", "0.0.0.0:8099")
	t.Setenv("CHAMADA_OMNI_KEY", "0123456789abcdef0123456789abcdef")
	t.Setenv("CHAMADA_OMNI_ORIGIN", "https://omni.filtrovali.com.br")
	t.Setenv("CHAMADA_OMNI_EVENTOS", "http://web:3000/api/chamadas/eventos")
	t.Setenv("CHAMADA_PONTE_URL", "ws://evolution:8097/v1/calls")
	t.Setenv("CHAMADA_PONTE_TOKEN", "fedcba9876543210fedcba9876543210")
}

func TestProducaoAceitaQualquerContatoPelaRedeInterna(t *testing.T) {
	producaoEnv(t)
	c, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.maxDuration != time.Hour || c.retention != 5*365*24*time.Hour {
		t.Fatalf("padrões da produção: %v %v", c.maxDuration, c.retention)
	}
	if !c.allowsPeer("5547999990000") || !c.allowsPeer("4915112345678") || c.allowsPeer("123") || c.allowsPeer("abc@lid") {
		t.Fatal("produção: qualquer número válido, nada além disso")
	}
	t.Setenv("CHAMADA_LIMITE_SEGUNDOS", "14400")
	t.Setenv("CHAMADA_RETENCAO_HORAS", "87600")
	if _, err = loadConfig(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHAMADA_LIMITE_SEGUNDOS", "14401")
	if _, err = loadConfig(); err == nil {
		t.Fatal("limite acima de 4 h aceito")
	}
}

func TestProducaoRecusaConfiguracaoFrouxa(t *testing.T) {
	casos := map[string][2]string{
		"lista de teste na produção":   {"CHAMADA_NUMEROS_TESTE", "5511999990000"},
		"origem sem https":             {"CHAMADA_OMNI_ORIGIN", "http://omni.filtrovali.com.br"},
		"eventos fora da rede interna": {"CHAMADA_OMNI_EVENTOS", "http://omni.filtrovali.com.br/api/chamadas/eventos"},
		"eventos em localhost":         {"CHAMADA_OMNI_EVENTOS", "http://localhost:3000/api/chamadas/eventos"},
		"ponte fora da rede interna":   {"CHAMADA_PONTE_URL", "ws://10.0.0.5:8097/v1/calls"},
		"sem a ponte da Evolution":     {"CHAMADA_CONEXAO", "propria"},
		"sem a integração do Omni":     {"CHAMADA_OMNI", "off"},
		"áudio na mesma porta da API":  {"CHAMADA_ESCUTAR_AUDIO", "0.0.0.0:8098"},
	}
	for nome, kv := range casos {
		t.Run(nome, func(t *testing.T) {
			producaoEnv(t)
			t.Setenv(kv[0], kv[1])
			if _, err := loadConfig(); err == nil {
				t.Fatal("aceito")
			}
		})
	}
}

func TestStagingTesteComListaPelaRedeInternaESimulacaoSoLoopback(t *testing.T) {
	producaoEnv(t)
	t.Setenv("CHAMADA_MODO", "teste")
	t.Setenv("CHAMADA_OMNI_ORIGIN", "https://omnistaging.filtrovali.com.br")
	if _, err := loadConfig(); err == nil {
		t.Fatal("teste sem a lista de números")
	}
	t.Setenv("CHAMADA_NUMEROS_TESTE", "5511999990000")
	c, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.allowsPeer("5547999990000") || !c.allowsPeer("5511999990000") || c.maxDuration != 10*time.Minute {
		t.Fatal("teste continua só com a lista e os limites de teste")
	}
	t.Setenv("CHAMADA_MODO", "simulado")
	t.Setenv("CHAMADA_CONEXAO", "propria")
	t.Setenv("CHAMADA_ESCUTAR_AUDIO", "")
	t.Setenv("CHAMADA_OMNI_EVENTOS", "http://127.0.0.1:3000/api/chamadas/eventos")
	if _, err := loadConfig(); err == nil {
		t.Fatal("simulação escutando fora do loopback")
	}
	t.Setenv("CHAMADA_ESCUTAR", "127.0.0.1:8098")
	if _, err := loadConfig(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHAMADA_OMNI_EVENTOS", "http://web:3000/api/chamadas/eventos")
	if _, err := loadConfig(); err == nil {
		t.Fatal("simulação aceitou nome interno")
	}
}

func TestPortaDoAudioNaoExpoeAPIInterna(t *testing.T) {
	interno := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(299) })
	h := audioOnly(interno)
	for caminho, esperado := range map[string]int{"/omni/audio": 299, "/health": 299, "/internal/control": 404, "/internal/recordings/a/b/c": 404, "/": 404} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, caminho, nil))
		if rec.Code != esperado {
			t.Fatalf("%s: %d", caminho, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/omni/audio", nil))
	if rec.Code != 404 {
		t.Fatal("POST no áudio passou")
	}
}

func TestGravacaoAcompanhaADuracaoDaLigacao(t *testing.T) {
	path := filepath.Join(t.TempDir(), "longa.wav")
	r, err := newRecorder(path, 20*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	defer r.file.Close()
	if r.limit != int64((20*time.Minute+recordingSlack).Seconds()*sampleRate) {
		t.Fatalf("limite da gravação: %d", r.limit)
	}
	// Antes o teto era fixo em 10 min; uma ligação de 15 min precisa caber.
	if r.limit <= 15*60*sampleRate {
		t.Fatal("gravação cortaria antes do fim da ligação")
	}
}
