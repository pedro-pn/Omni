package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestSamePhoneAcceptsOnlyBrazilianMobileNinthDigitAlias(t *testing.T) {
	for _, pair := range [][2]string{
		{"5547999990000", "554799990000"},
		{"5511988880000", "551188880000"},
		{"554799990000", "5547999990000"},
		{"15551234567", "15551234567"},
	} {
		if !samePhone(pair[0], pair[1]) {
			t.Fatalf("mesma identidade recusada: %v", pair)
		}
	}
	for _, pair := range [][2]string{
		{"5547999990000", "554799990001"},                 // outra pessoa
		{"5547999990000", "554899990000"},                 // outro DDD
		{"15551234567", "155591234567"},                   // outra numeração internacional
		{"5547922220000", "554722220000"},                 // telefone fixo não recebe essa equivalência
		{"5547999990000", "5547999990000@s.whatsapp.net"}, // entrada precisa ser número
		{"", ""}, {"123", "123"},
	} {
		if samePhone(pair[0], pair[1]) {
			t.Fatalf("identidades diferentes aceitas: %v", pair)
		}
	}
}

func TestTestNumberPolicyAcceptsAliasAndStillRejectsOtherContacts(t *testing.T) {
	a := testApp(t)
	a.cfg.mode = "teste"
	a.cfg.allowed = map[string]bool{"5547999990000": true, "5511999990000": false}
	if !a.cfg.allowsPeer("554799990000") || a.cfg.allowsPeer("554799990001") || a.cfg.allowsPeer("551199990000") {
		t.Fatal("lista de contatos incorreta")
	}
	a.setConnection(connection{State: "conectado"})
	a.incoming(&simCall{id: randomID(), peer: "554799990001", incoming: true})
	a.mu.Lock()
	rejected := a.current == nil
	a.mu.Unlock()
	if !rejected {
		t.Fatal("chamada de outro contato foi apresentada")
	}
	a.incoming(&simCall{id: randomID(), peer: "554799990000", incoming: true})
	a.mu.Lock()
	accepted := a.current != nil
	a.mu.Unlock()
	if !accepted {
		t.Fatal("identidade legada do contato permitido foi ignorada")
	}
}

func TestConnectionErrorsExposeOnlyDeliberatePublicReasons(t *testing.T) {
	message := "O QR expirou. Clique em Conectar linha para gerar outro."
	if got := connectionFailureMessage(fmt.Errorf("contexto interno: %w", &connectionFailure{message: message})); got != message {
		t.Fatal("motivo público foi perdido")
	}
	if got := connectionFailureMessage(errors.New("segredo-da-sessao")); strings.Contains(got, "segredo-da-sessao") {
		t.Fatal("erro interno foi exposto")
	}
	if got := connectionFailureMessage(context.DeadlineExceeded); !strings.Contains(got, "tempo") {
		t.Fatal("tempo excedido não foi explicado")
	}
}

type failedConnectionBackend struct{ err error }

func (b failedConnectionBackend) Connect(context.Context) error { return b.err }
func (b failedConnectionBackend) Dial(context.Context, string) (voiceCall, error) {
	return nil, errors.New("indisponível")
}
func (b failedConnectionBackend) Close() {}

func TestFailedConnectPreservesSpecificReasonInPanel(t *testing.T) {
	a := testApp(t)
	message := "O QR foi pareado com outra linha. Use o WhatsApp do número A configurado para este teste."
	a.backend = failedConnectionBackend{err: &connectionFailure{message: message}}
	if err := a.connect(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { a.mu.Lock(); defer a.mu.Unlock(); return a.conn.State == "erro" })
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn.Message != message {
		t.Fatal("erro específico foi substituído pela mensagem genérica")
	}
}
