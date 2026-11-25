// Prova de conceito local. Pareamento próprio ou ponte com a sessão da Evolution.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type config struct {
	mode, listen, listenAudio, dataDir, line      string
	allowed                                       map[string]bool
	maxDuration                                   time.Duration
	retention                                     time.Duration
	evolutionURL, evolutionKey, evolutionInstance string
	transport, bridgeURL, bridgeToken             string
	native                                        bool
	omniKey, omniOrigin, omniEvents               string
}

var phonePattern = regexp.MustCompile(`^[1-9][0-9]{9,14}$`)

// Nome de serviço da rede interna do Docker (web, voz, evolution): um rótulo só,
// sem ponto, então nunca resolve na internet.
var internalHostPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

// Endereço interno aceito para eventos e ponte: loopback sempre; nos modos que
// falam com o WhatsApp (teste no staging, producao), também o nome de um serviço
// da rede interna do compose.
func (c config) internalHost(host string) bool {
	return host == "127.0.0.1" || (c.real() && c.native && host != "localhost" && internalHostPattern.MatchString(host))
}

// Retenção padrão das gravações na produção: 5 anos.
const retencaoProducao = 5 * 365 * 24 * time.Hour

// Modos que falam com o WhatsApp de verdade.
func (c config) real() bool { return c.mode == "teste" || c.mode == "producao" }

var instancePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)

func loadConfig() (config, error) {
	c := config{mode: env("CHAMADA_MODO", "simulado"), listen: env("CHAMADA_ESCUTAR", "127.0.0.1:8096"),
		dataDir: env("CHAMADA_DADOS", "data"), line: os.Getenv("CHAMADA_LINHA_TESTE"), allowed: map[string]bool{},
		maxDuration: 10 * time.Minute, retention: 24 * time.Hour,
		evolutionURL: os.Getenv("CHAMADA_EVOLUTION_URL"), evolutionKey: os.Getenv("CHAMADA_EVOLUTION_KEY"),
		evolutionInstance: os.Getenv("CHAMADA_EVOLUTION_INSTANCIA"),
		transport:         env("CHAMADA_CONEXAO", "propria"), bridgeURL: os.Getenv("CHAMADA_PONTE_URL"), bridgeToken: os.Getenv("CHAMADA_PONTE_TOKEN")}
	c.native = os.Getenv("CHAMADA_OMNI") == "on"
	if raw := os.Getenv("CHAMADA_OMNI"); raw != "" && raw != "on" && raw != "off" {
		return c, errors.New("CHAMADA_OMNI deve ser on ou off")
	}
	c.omniKey, c.omniOrigin, c.omniEvents = os.Getenv("CHAMADA_OMNI_KEY"), os.Getenv("CHAMADA_OMNI_ORIGIN"), os.Getenv("CHAMADA_OMNI_EVENTOS")
	c.listenAudio = os.Getenv("CHAMADA_ESCUTAR_AUDIO")
	if c.mode != "simulado" && c.mode != "teste" && c.mode != "producao" {
		return c, errors.New("CHAMADA_MODO deve ser simulado, teste ou producao")
	}
	// Produção: integração do Omni pela ponte da Evolution, com o app em https.
	if c.mode == "producao" && (!c.native || c.transport != "evolution" || !strings.HasPrefix(c.omniOrigin, "https://")) {
		return c, errors.New("modo producao exige CHAMADA_OMNI=on, CHAMADA_CONEXAO=evolution e CHAMADA_OMNI_ORIGIN em https")
	}
	if c.native {
		u, err := url.Parse(c.omniEvents)
		o, originErr := url.Parse(c.omniOrigin)
		if (c.real() && c.transport != "evolution") || len(c.omniKey) < 32 || err != nil || originErr != nil ||
			u.Scheme != "http" || !c.internalHost(u.Hostname()) || u.Path != "/api/chamadas/eventos" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
			(o.Scheme != "http" && o.Scheme != "https") || o.Host == "" || o.Path != "" || o.User != nil || o.RawQuery != "" || o.Fragment != "" {
			return c, errors.New("serviço Omni exige chave interna, origem do app e endpoint interno de eventos")
		}
	}
	if c.transport != "propria" && c.transport != "evolution" {
		return c, errors.New("CHAMADA_CONEXAO deve ser propria ou evolution")
	}
	if c.transport == "evolution" {
		u, e := url.Parse(c.bridgeURL)
		if !c.real() || e != nil || u.Scheme != "ws" || !c.internalHost(u.Hostname()) ||
			u.Port() == "" || u.Path != "/v1/calls" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || len(c.bridgeToken) < 32 {
			return c, errors.New("ponte exige modo teste ou producao, CHAMADA_PONTE_URL ws://<interno>:porta/v1/calls e CHAMADA_PONTE_TOKEN com pelo menos 32 caracteres")
		}
	}
	// Simulação e a POC sozinha: só loopback. O Omni em teste (staging) e produção
	// roda num contêiner sem porta publicada (API interna) e, à parte, publica só o
	// áudio para o proxy.
	for name, addr := range map[string]string{"CHAMADA_ESCUTAR": c.listen, "CHAMADA_ESCUTAR_AUDIO": c.listenAudio} {
		if addr == "" && name == "CHAMADA_ESCUTAR_AUDIO" {
			continue
		}
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return c, fmt.Errorf("%s inválido", name)
		}
		if !(c.real() && c.native) && host != "localhost" && !net.ParseIP(host).IsLoopback() {
			return c, errors.New("fora da integração do Omni em teste ou producao, o serviço escuta somente em loopback")
		}
	}
	if c.listenAudio != "" && (!c.real() || !c.native || c.listenAudio == c.listen) {
		return c, errors.New("CHAMADA_ESCUTAR_AUDIO só com o Omni em teste ou producao, em porta diferente de CHAMADA_ESCUTAR")
	}
	for _, p := range strings.Split(os.Getenv("CHAMADA_NUMEROS_TESTE"), ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if !phonePattern.MatchString(p) {
			return c, errors.New("CHAMADA_NUMEROS_TESTE deve conter números com DDI, só dígitos")
		}
		c.allowed[p] = true
	}
	if c.mode == "teste" && ((!c.native && !phonePattern.MatchString(c.line)) || len(c.allowed) == 0) {
		return c, errors.New("modo teste exige CHAMADA_LINHA_TESTE e CHAMADA_NUMEROS_TESTE")
	}
	if c.mode == "producao" && len(c.allowed) > 0 {
		return c, errors.New("modo producao não usa CHAMADA_NUMEROS_TESTE (cada pessoa liga e atende qualquer contato pelo próprio número)")
	}
	// Produção: ligação de até 4 h (padrão 1 h) e gravação guardada por 5 anos
	// (decisão de 11/11/2026; LGPD), configurável até 10 anos.
	maxSeconds, maxHours := 600, 168
	if c.mode == "producao" {
		c.maxDuration, c.retention = time.Hour, retencaoProducao
		maxSeconds, maxHours = 4*3600, 10*365*24
	}
	for key, target := range map[string]*time.Duration{"CHAMADA_LIMITE_SEGUNDOS": &c.maxDuration, "CHAMADA_RETENCAO_HORAS": &c.retention} {
		if raw := os.Getenv(key); raw != "" {
			n, e := strconv.Atoi(raw)
			unit := time.Hour
			limit := maxHours
			if key == "CHAMADA_LIMITE_SEGUNDOS" {
				unit = time.Second
				limit = maxSeconds
			}
			if e != nil || n < 1 || n > limit {
				return c, fmt.Errorf("%s fora do intervalo permitido", key)
			}
			*target = time.Duration(n) * unit
		}
	}
	if c.evolutionURL != "" && (c.evolutionKey == "" || !instancePattern.MatchString(c.evolutionInstance)) {
		return c, errors.New("diagnóstico exige CHAMADA_EVOLUTION_KEY e CHAMADA_EVOLUTION_INSTANCIA")
	}
	return c, nil
}

// audioOnly deixa passar só o WebSocket do áudio (e a saúde); o resto é 404.
func audioOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.Method == http.MethodGet && r.URL.Path == "/omni/audio") || (r.Method == http.MethodGet && r.URL.Path == "/health") {
			next.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	if err = os.MkdirAll(cfg.dataDir, 0700); err != nil {
		log.Fatal("não foi possível criar a pasta de dados")
	}
	if err = os.Chmod(cfg.dataDir, 0700); err != nil {
		log.Fatal("não foi possível proteger a pasta de dados")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var handler http.Handler
	if cfg.native {
		manager := newNativeManager(ctx, cfg)
		defer manager.close()
		handler = manager.handler()
	} else {
		a, appErr := newApp(ctx, cfg)
		if appErr != nil {
			log.Fatal("não foi possível iniciar a prova de conceito")
		}
		defer a.close()
		handler = a.handler(cfg.listen)
	}
	ln, err := net.Listen("tcp", cfg.listen)
	if err != nil {
		log.Fatal("não foi possível abrir a porta local")
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute}
	// Produção: porta só do áudio do navegador (o proxy encaminha /omni/audio); a API interna fica de fora.
	var audioServer *http.Server
	if cfg.listenAudio != "" {
		audioLn, audioErr := net.Listen("tcp", cfg.listenAudio)
		if audioErr != nil {
			log.Fatal("não foi possível abrir a porta do áudio")
		}
		audioServer = &http.Server{Handler: audioOnly(handler), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute}
		go func() {
			if e := audioServer.Serve(audioLn); e != nil && !errors.Is(e, http.ErrServerClosed) {
				log.Fatal("porta do áudio interrompida")
			}
		}()
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
		if audioServer != nil {
			_ = audioServer.Shutdown(shutdown)
		}
	}()
	log.Printf("Chamadas POC (%s): http://%s — dados locais em %s", cfg.mode, ln.Addr(), filepath.Base(cfg.dataDir))
	if err = server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("servidor local interrompido")
	}
}
