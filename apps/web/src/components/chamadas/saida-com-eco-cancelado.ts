/**
 * Toca a voz da outra pessoa por uma conexão WebRTC interna (o navegador fala com
 * ele mesmo) em vez de direto do Web Audio.
 *
 * Por quê: o cancelamento de eco do Chrome (echoCancellation do microfone) só usa
 * como referência, de forma confiável, o áudio que chega por WebRTC. Tocada pelo
 * Web Audio, a voz da outra pessoa sai na caixa de som, volta pelo microfone e é
 * enviada de novo: ela ouve um eco leve da própria voz e a gravação (que guarda
 * o microfone enviado) também fica com eco.
 *
 * Se algo falhar (navegador sem WebRTC, autoplay bloqueado), devolve null e quem
 * chamou toca pelo caminho antigo.
 */
export type SaidaDeAudio = { parar: () => void };

export async function saidaComEcoCancelado(context: AudioContext, origem: AudioNode): Promise<SaidaDeAudio | null> {
  if (typeof RTCPeerConnection === "undefined") return null;
  const destino = context.createMediaStreamDestination();
  const envia = new RTCPeerConnection();
  const recebe = new RTCPeerConnection();
  const elemento = new Audio();
  elemento.autoplay = true;
  const parar = () => {
    try {
      origem.disconnect(destino);
    } catch {
      // Já desconectado.
    }
    elemento.pause();
    elemento.srcObject = null;
    envia.close();
    recebe.close();
  };
  try {
    envia.onicecandidate = (e) => e.candidate && void recebe.addIceCandidate(e.candidate).catch(() => {});
    recebe.onicecandidate = (e) => e.candidate && void envia.addIceCandidate(e.candidate).catch(() => {});
    const faixa = new Promise<MediaStreamTrack>((resolve) => {
      recebe.ontrack = (e) => resolve(e.track);
    });
    for (const t of destino.stream.getAudioTracks()) envia.addTrack(t, destino.stream);
    origem.connect(destino);
    const oferta = await envia.createOffer();
    await envia.setLocalDescription(oferta);
    await recebe.setRemoteDescription(oferta);
    const resposta = await recebe.createAnswer();
    await recebe.setLocalDescription(resposta);
    await envia.setRemoteDescription(resposta);
    const t = await Promise.race([faixa, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
    if (!t) throw new Error("sem faixa");
    elemento.srcObject = new MediaStream([t]);
    await elemento.play();
    return { parar };
  } catch {
    parar();
    return null;
  }
}
