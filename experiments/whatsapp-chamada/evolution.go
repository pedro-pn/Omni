package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type evolutionReport struct {
	At               time.Time `json:"at"`
	DuringCall       bool      `json:"duringCall"`
	InstanceFound    bool      `json:"instanceFound"`
	State            string    `json:"state"`
	SameLine         bool      `json:"sameLine"`
	RejectCall       bool      `json:"rejectCall"`
	WebhookEnabled   bool      `json:"webhookEnabled"`
	CallEventEnabled bool      `json:"callEventEnabled"`
	Messages         *int64    `json:"messages,omitempty"`
	Message          string    `json:"message"`
}

// Exclusivamente GET. Nunca configura instâncias, webhooks ou rejeição de chamadas.
func (a *app) diagnoseEvolution(ctx context.Context) (evolutionReport, error) {
	r := evolutionReport{At: time.Now().UTC()}
	if a.cfg.evolutionURL == "" {
		return r, errors.New("Configure a Evolution de teste antes do diagnóstico.")
	}
	u, err := url.Parse(a.cfg.evolutionURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return r, errors.New("Endereço da Evolution inválido.")
	}
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(path string, out any) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(a.cfg.evolutionURL, "/")+path, nil)
		if err != nil {
			return err
		}
		req.Header.Set("apikey", a.cfg.evolutionKey)
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return fmt.Errorf("status %d", resp.StatusCode)
		}
		return json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(out)
	}
	var instances []struct {
		Name  string `json:"name"`
		State string `json:"connectionStatus"`
		Owner string `json:"ownerJid"`
		Count struct {
			Messages *int64 `json:"Message"`
		} `json:"_count"`
	}
	if get("/instance/fetchInstances?instanceName="+url.QueryEscape(a.cfg.evolutionInstance), &instances) != nil {
		return r, errors.New("Não foi possível consultar a Evolution. Confira endereço, chave e instância.")
	}
	for _, i := range instances {
		if i.Name == a.cfg.evolutionInstance {
			r.InstanceFound = true
			r.State = i.State
			owner := strings.Split(strings.Split(i.Owner, "@")[0], ":")[0]
			r.SameLine = samePhone(owner, a.cfg.line)
			r.Messages = i.Count.Messages
		}
	}
	if !r.InstanceFound {
		return r, errors.New("A instância configurada não foi encontrada.")
	}
	var settings struct {
		RejectCall bool `json:"rejectCall"`
	}
	var webhook struct {
		Enabled bool     `json:"enabled"`
		Events  []string `json:"events"`
	}
	if get("/settings/find/"+a.cfg.evolutionInstance, &settings) != nil || get("/webhook/find/"+a.cfg.evolutionInstance, &webhook) != nil {
		return r, errors.New("Não foi possível conferir as configurações da instância.")
	}
	r.RejectCall = settings.RejectCall
	r.WebhookEnabled = webhook.Enabled
	for _, event := range webhook.Events {
		if strings.EqualFold(event, "CALL") {
			r.CallEventEnabled = true
		}
	}
	r.Message = "Consultas concluídas. Confira as mensagens no Omni antes, durante e depois da chamada."
	if r.RejectCall {
		r.Message = "A Evolution está configurada para rejeitar chamadas. Ajuste somente a instância de teste antes de ligar."
	}
	if !r.SameLine {
		r.Message = "A linha da Evolution difere de CHAMADA_LINHA_TESTE. Este diagnóstico ainda não comprova convivência no mesmo número."
	}
	a.mu.Lock()
	r.DuringCall = a.current != nil
	a.diagnostics = append([]evolutionReport{r}, a.diagnostics...)
	if len(a.diagnostics) > 30 {
		a.diagnostics = a.diagnostics[:30]
	}
	a.mu.Unlock()
	return r, nil
}
