package main

import (
	"context"
	"errors"
)

// Somente mensagens deliberadamente públicas chegam à tela. Erros internos do
// protocolo e do banco podem conter dados da sessão e continuam privados.
type connectionFailure struct{ message string }

func (e *connectionFailure) Error() string { return e.message }

func connectionFailureMessage(err error) string {
	var failure *connectionFailure
	if errors.As(err, &failure) {
		return failure.message
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "A conexão não foi concluída a tempo. Clique em Conectar linha para tentar novamente."
	}
	return "Não foi possível conectar. Confira a conexão do celular e tente novamente."
}
