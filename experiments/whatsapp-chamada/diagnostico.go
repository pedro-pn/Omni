package main

import (
	"log"
	"os"
	"regexp"
)

// Diagnóstico das chamadas (CHAMADA_DIAGNOSTICO=1): registra por onde a chamada
// passou e por que foi ignorada. Sem áudio, sem chaves; números e IDs mascarados.
var diagnosticoLigado = os.Getenv("CHAMADA_DIAGNOSTICO") == "1"

var numerosLongos = regexp.MustCompile(`[0-9]{6,}([0-9]{4})`)

func diag(formato string, args ...any) {
	if !diagnosticoLigado {
		return
	}
	for i, a := range args {
		if s, ok := a.(string); ok {
			args[i] = numerosLongos.ReplaceAllString(s, "…$1")
		}
		if e, ok := a.(error); ok && e != nil {
			args[i] = numerosLongos.ReplaceAllString(e.Error(), "…$1")
		}
	}
	log.Printf("[diagnóstico] "+formato, args...)
}
