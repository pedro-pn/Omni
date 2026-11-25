// Envelope explícito: não depende de dicionários binários iguais entre Baileys e Go.
export function encodeNode(node, depth = 0) {
  if (!node || depth > 32 || typeof node.tag !== 'string') throw new Error('invalid_node');
  const attrs = Object.fromEntries(Object.entries(node.attrs || {}).map(([k, v]) => [k, String(v)]));
  const result = { tag: node.tag, attrs };
  if (Array.isArray(node.content)) result.children = node.content.map(n => encodeNode(n, depth + 1));
  else if (node.content != null) result.data = Buffer.from(node.content).toString('base64');
  return result;
}

export function decodeNode(node, depth = 0) {
  if (!node || depth > 32 || typeof node.tag !== 'string' || !node.attrs ||
      Object.values(node.attrs).some(v => typeof v !== 'string') ||
      (node.children !== undefined && node.data !== undefined)) throw new Error('invalid_node');
  const result = { tag: node.tag, attrs: { ...node.attrs } };
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) throw new Error('invalid_node');
    result.content = node.children.map(n => decodeNode(n, depth + 1));
  } else if (node.data !== undefined) result.content = fromBase64(node.data);
  return result;
}

export function fromBase64(value) {
  if (typeof value !== 'string' || value.length > 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid_bytes');
  return Buffer.from(value, 'base64');
}

export function canonicalPhone(value) {
  if (!/^[1-9][0-9]{9,14}$/.test(value || '')) return '';
  return /^55[0-9]{2}9[6-9][0-9]{7}$/.test(value) ? value.slice(0, 4) + value.slice(5) : value;
}

export function bareJID(jid) {
  if (typeof jid !== 'string' || !/^[0-9]+(?::[0-9]+)?@(s\.whatsapp\.net|lid)$/.test(jid)) throw new Error('invalid_jid');
  return jid.replace(/:[0-9]+@/, '@');
}

export function isVoiceOffer(node) {
  const child = node.content?.[0];
  return child?.tag === 'offer' && child.attrs?.type !== 'group' && !child.attrs?.['group-jid'] &&
    !child.content?.some(n => n.tag === 'video');
}

export function isCallNode(node) {
  return node?.tag === 'call' || (node?.tag === 'ack' && node.attrs?.class === 'call');
}
