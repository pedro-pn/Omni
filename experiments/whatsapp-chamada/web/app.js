const $ = (id) => document.getElementById(id);
let state, socket, stream, context, processor, muted = false, playbackCallId, recordsKey = '', diagnosticsKey = '', busy = false;
let errorTimer;
function showError(message) { $('error').textContent = message; $('error').hidden = false; clearTimeout(errorTimer); errorTimer = setTimeout(() => { $('error').hidden = true; }, 7000); }
async function request(path, body) {
  const response = await fetch(path, body ? {method:'POST', headers:{'Content-Type':'application/json', 'X-Omni-Chamada':'poc'}, body:JSON.stringify(body)} : {});
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Não foi possível concluir.'); return data;
}
async function control(action, values = {}) {
  if (busy) return;
  busy = true;
  try { render(await request('/api/control', {action, ...values})); } catch (error) { showError(error.message); } finally { busy = false; }
}
function stopAudio() {
  if (socket) { socket.onclose = null; socket.close(); socket = undefined; }
  stream?.getTracks().forEach(track => track.stop()); stream = undefined;
  processor?.disconnect(); processor = undefined;
  context?.close(); context = undefined; muted = false;
  playbackCallId = undefined;
  $('microphone').textContent = 'Ativar microfone'; $('audio-status').textContent = 'Microfone desligado'; $('mute').disabled = true;
}
async function startAudio() {
  if (socket?.readyState === WebSocket.OPEN) { stopAudio(); return; }
  $('microphone').disabled = true;
  try {
    context = new AudioContext({sampleRate:16000}); await context.resume();
    if (context.sampleRate !== 16000) throw new Error('Use um navegador que aceite áudio a 16 kHz, como Chrome ou Edge.');
    stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1, echoCancellation:true, noiseSuppression:true}, video:false});
    for (const track of stream.getAudioTracks()) track.onended = () => { stopAudio(); showError('O microfone foi desconectado.'); };
    await context.audioWorklet.addModule('/audio-worklet.js');
    processor = new AudioWorkletNode(context, 'omni-audio', {numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[1]});
    socket = new WebSocket(`ws://${location.host}/api/audio`); socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Não foi possível abrir o áudio. Feche o teste em outras abas.')); });
    processor.port.onmessage = ({data}) => { if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 1920 * 5) socket.send(data); };
    socket.onmessage = ({data}) => { if (typeof data === 'string') render(JSON.parse(data)); else processor?.port.postMessage({type:'audio', buffer:data}, [data]); };
    socket.onclose = () => { stopAudio(); showError('Áudio desconectado. Ative o microfone novamente.'); };
    context.createMediaStreamSource(stream).connect(processor); processor.connect(context.destination);
    $('microphone').textContent = 'Desligar microfone'; $('audio-status').textContent = 'Microfone e fone conectados'; $('mute').disabled = false;
  } catch (error) { stopAudio(); showError(error.message || 'Autorize o microfone para continuar.'); }
  finally { $('microphone').disabled = false; }
}
const stateLabels = {desconectado:'Desconectado', conectando:'Conectando', conectado:'Conectado', pareando:'Leia o QR em Aparelhos conectados', erro:'Conexão indisponível', ligando:'Ligando', tocando:'Chamando', recebendo:'Chamada recebida', ativa:'Em chamada'};
function render(next) {
  state = next;
  const simulation = state.mode === 'simulado';
  $('mode').textContent = simulation ? 'MODO SIMULADO' : 'WHATSAPP DE TESTE';
  if (!simulation && state.transport === 'evolution') $('mode').textContent = 'WHATSAPP · SESSÃO DA EVOLUTION';
  $('connect').textContent = state.transport === 'evolution' ? 'Conectar à Evolution' : 'Conectar linha';
  $('notice').textContent = simulation ? 'Simulação local: o lado remoto fica em silêncio. Ative o tom de teste se quiser verificar o som. Use fones.' : 'Chamadas reais apenas entre os números de teste configurados. Avise os participantes sobre a gravação e use fones.';
  $('test-tone-label').hidden = !simulation;
  $('test-tone').checked = !!state.testTone;
  $('connection').textContent = `${stateLabels[state.connection.state] || state.connection.state}${state.connection.phone ? ' · '+state.connection.phone : ''}`;
  $('connection-message').textContent = state.connection.message || '';
  $('qr').hidden = !state.connection.qr; if (state.connection.qr && $('qr').getAttribute('src') !== state.connection.qr) $('qr').src = state.connection.qr;
  $('connect').disabled = ['conectado','conectando','pareando'].includes(state.connection.state);
  $('allowed').textContent = simulation ? 'Use qualquer número fictício válido para simular.' : 'Destinos permitidos: ' + state.allowed.join(', ');
  $('incoming').hidden = !simulation;
  const call = state.call;
  if (processor && playbackCallId !== (call?.id ?? null)) {
    processor.port.postMessage({type:'reset'});
    playbackCallId = call?.id ?? null;
  }
  $('dial').disabled = !!call || state.connection.state !== 'conectado' || socket?.readyState !== WebSocket.OPEN;
  $('incoming').disabled = !!call || state.connection.state !== 'conectado';
  $('answer').hidden = call?.state !== 'recebendo'; $('reject').hidden = call?.state !== 'recebendo';
  $('hangup').disabled = !call;
  $('call-state').textContent = call ? (stateLabels[call.state] || call.state) : 'Nenhuma chamada';
  $('call-peer').textContent = call ? `${call.direction === 'entrada' ? 'Recebida de' : 'Para'} ${call.peer}` : '';
  $('call-metrics').textContent = call ? `Quadros do microfone: ${call.micFrames} · recebidos: ${call.peerFrames} · descartados: ${call.dropped}` : '';
  $('diagnose').disabled = !state.evolutionConfigured;
  $('evolution-help').textContent = state.evolutionConfigured ? 'Somente leitura. A ausência do evento CALL no webhook não impede este serviço de voz.' : 'Configure CHAMADA_EVOLUTION_URL, CHAMADA_EVOLUTION_KEY e CHAMADA_EVOLUTION_INSTANCIA para consultar.';
  $('retention').textContent = `Exclusão automática após ${state.retentionHours} h, enquanto o serviço estiver rodando; também é conferida na partida.`;
  const key = JSON.stringify(state.records);
  if (key !== recordsKey) { recordsKey = key; renderRecords(state.records); }
  const dkey = JSON.stringify(state.diagnostics);
  if (dkey !== diagnosticsKey) { diagnosticsKey = dkey; $('diagnostics').replaceChildren(...state.diagnostics.map(d => {
    const li = document.createElement('li');
    li.textContent = `${new Date(d.at).toLocaleTimeString('pt-BR')} · ${d.duringCall ? 'durante chamada' : 'sem chamada'} · ${d.state} · mesma linha: ${d.sameLine ? 'sim' : 'não'} · rejeição automática: ${d.rejectCall ? 'ligada' : 'desligada'}${d.messages == null ? '' : ' · mensagens: '+d.messages}. ${d.message}`;
    return li;
  })); }
}
function renderRecords(records) {
  $('recordings').replaceChildren();
  if (!records.length) { const p = document.createElement('p'); p.textContent = 'Nenhuma chamada concluída.'; $('recordings').append(p); return; }
  for (const record of records) {
    const article = document.createElement('article'), title = document.createElement('p'), details = document.createElement('p');
    title.textContent = `${record.mode === 'simulado' ? 'Simulada' : 'WhatsApp'} · ${record.peer} · ${new Date(record.createdAt).toLocaleString('pt-BR')}`;
    details.className = 'muted'; details.textContent = `${record.direction === 'entrada' ? 'Recebida' : 'Realizada'} · microfone: ${record.micFrames} quadros · cliente: ${record.peerFrames} quadros${record.recordingError ? ' · Falha ao salvar a gravação' : ''}`;
    article.append(title, details);
    if (record.audio) {
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.src = `/api/recordings/${record.id}.wav`;
      const link = document.createElement('a'); link.className = 'button secondary'; link.href = audio.src; link.download = `${record.id}.wav`; link.textContent = 'Baixar gravação';
      const separate = document.createElement('a'); separate.className = 'button secondary'; separate.href = `${audio.src}?canais=separados`; separate.download = `${record.id}-canais.wav`; separate.textContent = 'Baixar canais separados'; separate.title = 'Atendente à esquerda e cliente à direita';
      article.append(audio, link, ' ', separate);
    }
    const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = 'Apagar'; remove.onclick = () => control('delete', {id:record.id}); article.append(' ', remove); $('recordings').append(article);
  }
}
$('connect').onclick = () => control('connect');
$('microphone').onclick = startAudio;
$('dial-form').onsubmit = event => { event.preventDefault(); control('dial', {peer:$('peer').value.trim(), notified:$('notified').checked}); };
$('incoming').onclick = () => control('incoming');
$('test-tone').onchange = () => control('test-tone', {enabled:$('test-tone').checked});
$('answer').onclick = () => control('answer', {id:state.call?.id, notified:$('notified').checked});
$('hangup').onclick = () => control('hangup', {id:state.call?.id});
$('reject').onclick = () => control('reject', {id:state.call?.id});
$('mute').onclick = () => { muted = !muted; processor?.port.postMessage({type:'mute', value:muted}); $('mute').textContent = muted ? 'Reativar áudio' : 'Silenciar'; };
$('diagnose').onclick = async () => { $('diagnose').disabled = true; try { await request('/api/evolution/diagnostico', {}); render(await request('/api/status')); } catch (error) { showError(error.message); } finally { $('diagnose').disabled = !state?.evolutionConfigured; } };
async function refresh() { try { render(await request('/api/status')); } catch { showError('Serviço local indisponível.'); } }
await refresh(); setInterval(refresh, 1500);
window.addEventListener('pagehide', stopAudio);
