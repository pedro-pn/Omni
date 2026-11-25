package main

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/coder/websocket"
)

//go:embed web/*
var assets embed.FS
var idPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

func jsonResponse(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
func apiError(w http.ResponseWriter, status int, message string) {
	jsonResponse(w, status, map[string]string{"error": message})
}

func (a *app) handler(address string) http.Handler {
	_, port, _ := net.SplitHostPort(address)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	static, _ := fs.Sub(assets, "web")
	mux.Handle("GET /", http.FileServer(http.FS(static)))
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, a.snapshot()) })
	mux.HandleFunc("GET /api/report", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="chamadas-poc.json"`)
		jsonResponse(w, 200, a.snapshot())
	})
	mux.HandleFunc("POST /api/control", a.handleControl)
	mux.HandleFunc("POST /api/evolution/diagnostico", func(w http.ResponseWriter, r *http.Request) {
		report, err := a.diagnoseEvolution(r.Context())
		if err != nil {
			apiError(w, 502, err.Error())
			return
		}
		jsonResponse(w, 200, report)
	})
	mux.HandleFunc("GET /api/audio", a.handleAudio)
	mux.HandleFunc("GET /api/recordings/{file}", func(w http.ResponseWriter, r *http.Request) {
		file := r.PathValue("file")
		id := strings.TrimSuffix(file, ".wav")
		if file != id+".wav" || !idPattern.MatchString(id) {
			http.NotFound(w, r)
			return
		}
		a.mu.Lock()
		found := false
		for _, v := range a.records {
			if v.ID == id && v.Audio {
				found = true
			}
		}
		a.mu.Unlock()
		if !found {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "audio/wav")
		if r.URL.Query().Get("canais") == "separados" {
			http.ServeFile(w, r, filepath.Join(a.cfg.dataDir, file))
			return
		}
		source, err := os.Open(filepath.Join(a.cfg.dataDir, file))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer source.Close()
		info, err := source.Stat()
		if err != nil {
			apiError(w, 500, "Não foi possível abrir a gravação.")
			return
		}
		playback, err := recordingForPlayback(source, info.Size())
		if err != nil {
			apiError(w, 500, "Não foi possível preparar a reprodução.")
			return
		}
		http.ServeContent(w, r, file, info.ModTime(), playback)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, requestPort, err := net.SplitHostPort(r.Host)
		if err != nil || requestPort != port || (host != "localhost" && !net.ParseIP(host).IsLoopback()) {
			http.Error(w, "Acesso somente local.", 403)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "microphone=(self)")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws://"+r.Host+"; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'")
		if r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+r.Host {
			apiError(w, 403, "Origem recusada.")
			return
		}
		if r.URL.Path == "/" && r.Method == http.MethodGet {
			http.SetCookie(w, &http.Cookie{Name: "omni_chamada_poc", Value: a.token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
		} else if strings.HasPrefix(r.URL.Path, "/api/") {
			cookie, err := r.Cookie("omni_chamada_poc")
			if err != nil || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(a.token)) != 1 {
				apiError(w, 401, "Abra a página local antes de continuar.")
				return
			}
		}
		if r.Method == http.MethodPost && (r.Header.Get("X-Omni-Chamada") != "poc" || r.Header.Get("Content-Type") != "application/json") {
			apiError(w, 403, "Requisição recusada.")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *app) handleControl(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Action   string `json:"action"`
		Peer     string `json:"peer"`
		ID       string `json:"id"`
		Notified bool   `json:"notified"`
		Enabled  bool   `json:"enabled"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil {
		apiError(w, 400, "Comando inválido.")
		return
	}
	var err error
	switch input.Action {
	case "connect":
		err = a.connect()
	case "dial":
		if !input.Notified {
			apiError(w, 400, "Confirme que os participantes foram avisados da gravação.")
			return
		}
		err = a.dial(input.Peer)
	case "incoming":
		err = a.simulateIncoming()
	case "test-tone":
		if a.cfg.mode != "simulado" {
			apiError(w, 409, "O som de teste só está disponível na simulação.")
			return
		}
		a.simTone.Store(input.Enabled)
	case "answer":
		err = a.answer(input.ID, input.Notified)
	case "hangup", "reject":
		if !idPattern.MatchString(input.ID) {
			apiError(w, 400, "Chamada inválida.")
			return
		}
		a.end("encerrada_pelo_operador", input.Action == "reject", input.ID)
	case "delete":
		if !idPattern.MatchString(input.ID) {
			apiError(w, 400, "Gravação inválida.")
			return
		}
		err = a.deleteRecord(input.ID)
	default:
		apiError(w, 400, "Comando desconhecido.")
		return
	}
	if err != nil {
		apiError(w, 409, err.Error())
		return
	}
	jsonResponse(w, 200, a.snapshot())
}

func (a *app) handleAudio(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	if a.audioAttached {
		a.mu.Unlock()
		apiError(w, 409, "Outro navegador já controla o áudio.")
		return
	}
	a.audioAttached = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.audioAttached = false
		s := a.current
		var id string
		if s != nil {
			id = s.info.ID
		}
		a.mu.Unlock()
		if id != "" {
			a.end("navegador_desconectado", false, id)
		}
	}()
	options := &websocket.AcceptOptions{}
	if a.cfg.native {
		u, _ := url.Parse(a.cfg.omniOrigin)
		options.OriginPatterns = []string{u.Host}
	}
	conn, err := websocket.Accept(w, r, options)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(frameSamples * 2)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		defer cancel()
		for {
			kind, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if kind != websocket.MessageBinary || len(data) != frameSamples*2 {
				_ = conn.Close(websocket.StatusPolicyViolation, "Áudio inválido.")
				return
			}
			a.mu.Lock()
			s := a.current
			a.mu.Unlock()
			if s != nil {
				_ = s.media.pushPCM(data)
			}
		}
	}()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		a.mu.Lock()
		s := a.current
		a.mu.Unlock()
		var playback <-chan []byte
		if s != nil {
			playback = s.media.playback
		}
		var kind websocket.MessageType
		var data []byte
		select {
		case <-ctx.Done():
			return
		case data = <-playback:
			kind = websocket.MessageBinary
		case <-ticker.C:
			kind = websocket.MessageText
			data, _ = json.Marshal(a.snapshot())
		}
		writeCtx, stop := context.WithTimeout(ctx, 2*time.Second)
		err = conn.Write(writeCtx, kind, data)
		stop()
		if err != nil {
			return
		}
	}
}
