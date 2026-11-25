package main

// O WhatsApp pode manter o identificador antigo de celulares brasileiros, sem
// o nono dígito. A equivalência conserva DDI, DDD e os oito dígitos originais;
// não autoriza outro contato nem altera o número configurado pelo operador.
func samePhone(left, right string) bool {
	if !phonePattern.MatchString(left) || !phonePattern.MatchString(right) {
		return false
	}
	return phoneIdentity(left) == phoneIdentity(right)
}

func phoneIdentity(phone string) string {
	if len(phone) == 13 && phone[:2] == "55" && phone[4] == '9' && phone[5] >= '6' && phone[5] <= '9' {
		return phone[:4] + phone[5:]
	}
	return phone
}

func (c config) allowsPeer(phone string) bool {
	// Produção: qualquer contato com número válido (cada pessoa usa o próprio WhatsApp).
	if c.mode == "producao" {
		return phonePattern.MatchString(phone)
	}
	for allowed, enabled := range c.allowed {
		if enabled && samePhone(allowed, phone) {
			return true
		}
	}
	return false
}
