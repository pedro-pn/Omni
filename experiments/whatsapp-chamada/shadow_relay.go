package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	waBinary "github.com/polymorfa/hypermeow/binary"
	"github.com/polymorfa/hypermeow/store"
	"github.com/polymorfa/hypermeow/types"
	"github.com/polymorfa/libsignal-protocol-go/keys/prekey"
)

// Não transporta bytes com o dicionário binário do WhatsApp: cada biblioteca pode
// ter uma versão diferente. JIDs são convertidos explicitamente, inclusive @lid.
type relayNode struct {
	Tag      string            `json:"tag"`
	Attrs    map[string]string `json:"attrs"`
	Data     *[]byte           `json:"data,omitempty"`
	Children *[]relayNode      `json:"children,omitempty"`
}

func nodeToRelay(n waBinary.Node) (relayNode, error) {
	r := relayNode{Tag: n.Tag, Attrs: map[string]string{}}
	for k, v := range n.Attrs {
		if v != nil {
			r.Attrs[k] = fmt.Sprint(v)
		}
	}
	switch content := n.Content.(type) {
	case nil:
	case []byte:
		r.Data = &content
	case []waBinary.Node:
		children := make([]relayNode, 0, len(content))
		for _, child := range content {
			c, err := nodeToRelay(child)
			if err != nil {
				return r, err
			}
			children = append(children, c)
		}
		r.Children = &children
	default:
		return r, errors.New("conteúdo de nó não suportado")
	}
	return r, nil
}

func (r relayNode) node(depth int) (waBinary.Node, error) {
	n := waBinary.Node{Tag: r.Tag, Attrs: waBinary.Attrs{}}
	if depth > 32 || r.Tag == "" || r.Attrs == nil || (r.Data != nil && r.Children != nil) {
		return n, errors.New("nó inválido na ponte")
	}
	for k, v := range r.Attrs {
		if strings.Contains(v, "@") {
			jid, err := types.ParseJID(v)
			if err != nil {
				return n, err
			}
			n.Attrs[k] = jid
		} else {
			n.Attrs[k] = v
		}
	}
	if r.Data != nil {
		n.Content = *r.Data
	}
	if r.Children != nil {
		children := make([]waBinary.Node, 0, len(*r.Children))
		for _, child := range *r.Children {
			c, err := child.node(depth + 1)
			if err != nil {
				return n, err
			}
			children = append(children, c)
		}
		n.Content = children
	}
	return n, nil
}

type relayMessage struct {
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params any             `json:"params,omitempty"`
	Epoch  string          `json:"epoch,omitempty"`
	Event  string          `json:"event,omitempty"`
	Node   *relayNode      `json:"node,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type shadowRelay struct {
	ws      *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	epoch   string // definida antes de subscribe; imutável depois disso
	seq     atomic.Uint64
	mu      sync.Mutex
	pending map[string]chan relayMessage
	nodes   chan relayMessage
	once    sync.Once
}

func openShadowRelay(ctx context.Context, address, token string) (*shadowRelay, error) {
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	ws, response, err := websocket.Dial(dialCtx, address, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + token}},
		HTTPClient: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	})
	if err != nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, &connectionFailure{message: "Não foi possível acessar a ponte local. Confira se a Evolution com suporte a chamadas está iniciada e se a chave está configurada."}
	}
	ws.SetReadLimit(1024 * 1024)
	life, stop := context.WithCancel(ctx)
	r := &shadowRelay{ws: ws, ctx: life, cancel: stop, pending: map[string]chan relayMessage{}, nodes: make(chan relayMessage, 64)}
	go r.read()
	go r.keepalive()
	return r, nil
}

func (r *shadowRelay) keepalive() {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(r.ctx, 5*time.Second)
			err := r.ws.Ping(ctx)
			cancel()
			if err != nil {
				r.close()
				return
			}
		}
	}
}

func (r *shadowRelay) close() {
	r.once.Do(func() { r.cancel(); _ = r.ws.CloseNow() })
}

func (r *shadowRelay) read() {
	defer r.close()
	for {
		kind, data, err := r.ws.Read(r.ctx)
		if err != nil || kind != websocket.MessageText {
			return
		}
		var m relayMessage
		if json.Unmarshal(data, &m) != nil {
			return
		}
		if m.Event != "" {
			select {
			case r.nodes <- m:
			default:
				return
			}
		} else if m.ID != "" {
			r.mu.Lock()
			ch := r.pending[m.ID]
			r.mu.Unlock()
			if ch != nil {
				select {
				case ch <- m:
				default:
				}
			}
		} else {
			return
		}
	}
}

func (r *shadowRelay) rpc(ctx context.Context, method string, params, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	id := strconv.FormatUint(r.seq.Add(1), 10)
	ch := make(chan relayMessage, 1)
	r.mu.Lock()
	r.pending[id] = ch
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.pending, id); r.mu.Unlock() }()
	data, err := json.Marshal(relayMessage{ID: id, Method: method, Params: params, Epoch: r.epoch})
	if err != nil {
		return err
	}
	if err = r.ws.Write(ctx, websocket.MessageText, data); err != nil {
		return err
	}
	select {
	case m := <-ch:
		if m.Error != "" {
			return errors.New("operação recusada pela ponte")
		}
		if result != nil {
			return json.Unmarshal(m.Result, result)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-r.ctx.Done():
		return errors.New("ponte desconectada")
	}
}

func (r *shadowRelay) SendNode(ctx context.Context, data []byte) error {
	unpacked, err := waBinary.Unpack(data)
	if err != nil {
		return err
	}
	n, err := waBinary.Unmarshal(unpacked)
	if err != nil {
		return err
	}
	if n.Tag != "call" && !(n.Tag == "ack" && n.AttrGetter().String("class") == "call") {
		return errors.New("ponte permite somente sinalização de chamadas")
	}
	encoded, err := nodeToRelay(*n)
	if err != nil {
		return err
	}
	return r.rpc(ctx, "send", map[string]any{"node": encoded}, nil)
}

func (r *shadowRelay) DecryptDM(ctx context.Context, child *waBinary.Node, from types.JID, _ bool) ([]byte, *[32]byte, error) {
	if child == nil {
		return nil, nil, errors.New("enc ausente")
	}
	n, err := nodeToRelay(*child)
	if err != nil {
		return nil, nil, err
	}
	var result struct {
		Plaintext []byte `json:"plaintext"`
	}
	diag("ponte: pedindo para decifrar %s de %s", child.AttrGetter().OptionalString("type"), from.String())
	err = r.rpc(ctx, "decrypt", map[string]any{"node": n, "jid": from.String()}, &result)
	if err != nil {
		diag("ponte: decifrar falhou (%v)", err)
	} else {
		diag("ponte: decifrado (%d bytes)", len(result.Plaintext))
	}
	return result.Plaintext, nil, err
}

func (r *shadowRelay) EncryptForDevice(ctx context.Context, plaintext []byte, to types.JID, _ *prekey.Bundle, attrs waBinary.Attrs) (*waBinary.Node, bool, error) {
	var result struct {
		Node     relayNode `json:"node"`
		Identity bool      `json:"identity"`
	}
	err := r.rpc(ctx, "encrypt", map[string]any{"plaintext": plaintext, "jid": to.String()}, &result)
	if err != nil {
		return nil, false, err
	}
	n, err := result.Node.node(0)
	for k, v := range attrs {
		n.Attrs[k] = v
	}
	return &n, result.Identity, err
}

func jidStrings(jids []types.JID) []string {
	values := make([]string, len(jids))
	for i, jid := range jids {
		values[i] = jid.String()
	}
	return values
}

func (r *shadowRelay) FetchPreKeys(ctx context.Context, devices []types.JID) (map[types.JID]*prekey.Bundle, error) {
	// O Baileys busca E INSTALA as prekeys na sessão autoritativa. Nenhum estado
	// Signal é importado no Go; EncryptForDevice consulta a mesma sessão depois.
	err := r.rpc(ctx, "ensureSessions", map[string]any{"jids": jidStrings(devices)}, nil)
	return map[types.JID]*prekey.Bundle{}, err
}

func (r *shadowRelay) GetUserDevices(ctx context.Context, users []types.JID) ([]types.JID, error) {
	var result struct {
		JIDs []string `json:"jids"`
	}
	if err := r.rpc(ctx, "devices", map[string]any{"jids": jidStrings(users)}, &result); err != nil {
		return nil, err
	}
	jids := make([]types.JID, len(result.JIDs))
	for i, value := range result.JIDs {
		jid, err := types.ParseJID(value)
		if err != nil {
			return nil, err
		}
		jids[i] = jid
	}
	return jids, nil
}

func (r *shadowRelay) resolve(ctx context.Context, method string, jid types.JID) (types.JID, error) {
	var result struct {
		JID string `json:"jid"`
	}
	if err := r.rpc(ctx, method, map[string]any{"jid": jid.String()}, &result); err != nil {
		return types.EmptyJID, err
	}
	return types.ParseJID(result.JID)
}

func (r *shadowRelay) ResolveLID(ctx context.Context, pn types.JID) (types.JID, error) {
	return r.resolve(ctx, "resolveLID", pn)
}

func (r *shadowRelay) GetUserInfo(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
	result := map[types.JID]types.UserInfo{}
	for _, jid := range jids {
		lid, err := r.ResolveLID(ctx, jid)
		if err != nil {
			return nil, err
		}
		result[jid] = types.UserInfo{LID: lid}
	}
	return result, nil
}

func (r *shadowRelay) GetPrivacyToken(ctx context.Context, user types.JID) (*store.PrivacyToken, error) {
	var result struct {
		Token     []byte `json:"token"`
		Timestamp int64  `json:"timestamp"`
	}
	if err := r.rpc(ctx, "privacyToken", map[string]any{"jid": user.String()}, &result); err != nil {
		return nil, err
	}
	if len(result.Token) == 0 {
		return nil, nil
	}
	return &store.PrivacyToken{User: user, Token: result.Token, Timestamp: time.Unix(result.Timestamp, 0)}, nil
}

// As leituras inversas (@lid → telefone) são necessárias para conferir a lista
// de testes nas chamadas recebidas. Não gravamos os mapeamentos em disco.
type relayLIDStore struct{ relay *shadowRelay }

func (s *relayLIDStore) GetLIDForPN(ctx context.Context, pn types.JID) (types.JID, error) {
	return s.relay.ResolveLID(ctx, pn)
}
func (s *relayLIDStore) GetPNForLID(ctx context.Context, lid types.JID) (types.JID, error) {
	return s.relay.resolve(ctx, "resolvePN", lid)
}
func (s *relayLIDStore) GetManyLIDsForPNs(ctx context.Context, pns []types.JID) (map[types.JID]types.JID, error) {
	result := map[types.JID]types.JID{}
	for _, pn := range pns {
		lid, err := s.GetLIDForPN(ctx, pn)
		if err != nil {
			return nil, err
		}
		result[pn] = lid
	}
	return result, nil
}
func (*relayLIDStore) PutManyLIDMappings(context.Context, []store.LIDMapping) error { return nil }
func (*relayLIDStore) PutLIDMapping(context.Context, types.JID, types.JID) error    { return nil }
