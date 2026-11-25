import { Smile } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Painel de emojis da resposta: categorias e os usados por último (guardados só
 * neste navegador). No Windows, Win + . também abre os emojis do sistema.
 */

const CATEGORIAS: { nome: string; icone: string; emojis: string }[] = [
  {
    nome: "Rostos",
    icone: "😀",
    emojis:
      "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬",
  },
  {
    nome: "Gestos",
    icone: "👍",
    emojis:
      "👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 👏 🙌 👐 🤲 💪 🦾 ✍️ 💅 🫡 🫶 👀 🧠 🗣️ 👤 👥 🧑‍💼 👷 🧑‍🔧 🧑‍🏭 🧑‍🔬 🧑‍💻 🧑‍🚒 🚶 🏃",
  },
  {
    nome: "Corações",
    icone: "❤️",
    emojis: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ✨ ⭐ 🌟 💫 🔥 💥 🎉 🎊 🥂 🍾 🏆 🥇 🎯 🎁",
  },
  {
    nome: "Trabalho",
    icone: "🛠️",
    emojis:
      "🛠️ 🔧 🔩 ⚙️ 🧰 🪛 🔨 ⛏️ 🪚 🧪 🧯 🛢️ ⛽ 🚚 🚛 🚜 🏗️ 🏭 🚢 ⚓ ✈️ 🚗 🛻 📦 📋 📄 📑 📊 📈 📉 🗂️ 📁 📌 📍 📎 🖊️ ✏️ 📝 📅 📆 🗓️ ⏰ ⏱️ ⌛ 💼 💰 💵 🧾 💳 📞 📱 💻 🖨️ 📷 🔒 🔑 💡 🔋 🔌 🧲",
  },
  {
    nome: "Natureza",
    icone: "🌿",
    emojis: "☀️ 🌤️ ⛅ 🌥️ ☁️ 🌦️ 🌧️ ⛈️ 🌩️ 🌪️ 🌈 ❄️ 💧 🌊 🌿 🍀 🌱 🌳 🌲 🌴 🌵 🌻 🌹 🌷 🌸 🐶 🐱 🐟 🐦 🦋 🐝",
  },
  {
    nome: "Comida",
    icone: "☕",
    emojis: "☕ 🍵 🧃 🥤 🍺 🍻 🍷 🍕 🍔 🌭 🥪 🌮 🍝 🍛 🍲 🥗 🍖 🍗 🥩 🍞 🧀 🥚 🍳 🥐 🍰 🎂 🍫 🍩 🍪 🍎 🍌 🍉 🍇 🍓 🍍",
  },
  {
    nome: "Símbolos",
    icone: "✅",
    emojis:
      "✅ ☑️ ✔️ ❌ ❎ ⚠️ 🚫 ⛔ ❗ ❕ ❓ ❔ ‼️ ⁉️ 💯 🆗 🆕 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 ➡️ ⬅️ ⬆️ ⬇️ 🔄 🔁 ➕ ➖ ✖️ ➗ 🕐 🕑 🕒 🇧🇷",
  },
];

const CHAVE_RECENTES = "omni:emojis-recentes";

function lerRecentes(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CHAVE_RECENTES) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string").slice(0, 24) : [];
  } catch {
    return [];
  }
}

export function BotaoEmojis({ aoEscolher }: { aoEscolher: (emoji: string) => void }) {
  const [aberto, setAberto] = useState(false);
  const [recentes, setRecentes] = useState<string[]>([]);
  const [aba, setAba] = useState(0);
  const caixa = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const r = lerRecentes();
    setRecentes(r);
    setAba(r.length ? -1 : 0);
    const fora = (e: PointerEvent) => !caixa.current?.contains(e.target as Node) && setAberto(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAberto(false);
    document.addEventListener("pointerdown", fora);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", fora);
      document.removeEventListener("keydown", esc);
    };
  }, [aberto]);
  const escolher = (e: string) => {
    aoEscolher(e);
    const novos = [e, ...recentes.filter((x) => x !== e)].slice(0, 24);
    setRecentes(novos);
    try {
      localStorage.setItem(CHAVE_RECENTES, JSON.stringify(novos));
    } catch {
      // Sem armazenamento: só não lembra.
    }
  };
  const lista = aba === -1 ? recentes : CATEGORIAS[aba]!.emojis.split(" ");
  return (
    <div ref={caixa} className="relative">
      <button
        type="button"
        onClick={() => setAberto((a) => !a)}
        aria-expanded={aberto}
        aria-label="Emojis"
        title="Emojis"
        className="flex size-10 items-center justify-center rounded-md border border-linha hover:bg-superficie-2"
      >
        <Smile size={18} aria-hidden />
      </button>
      {aberto && (
        <div role="dialog" aria-label="Emojis" className="absolute bottom-12 left-0 z-30 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-linha bg-superficie shadow-xl">
          <div role="tablist" aria-label="Categorias" className="flex gap-0.5 border-b border-linha p-1">
            {recentes.length > 0 && (
              <button type="button" role="tab" aria-selected={aba === -1} title="Recentes" onClick={() => setAba(-1)} className={`flex-1 rounded py-1 text-lg ${aba === -1 ? "bg-superficie-2" : ""}`}>
                🕘
              </button>
            )}
            {CATEGORIAS.map((c, i) => (
              <button key={c.nome} type="button" role="tab" aria-selected={aba === i} title={c.nome} onClick={() => setAba(i)} className={`flex-1 rounded py-1 text-lg ${aba === i ? "bg-superficie-2" : ""}`}>
                {c.icone}
              </button>
            ))}
          </div>
          <p className="rotulo px-2 pt-2 text-muted">{aba === -1 ? "Recentes" : CATEGORIAS[aba]!.nome}</p>
          <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto p-1.5">
            {lista.map((e) => (
              <button key={e} type="button" onClick={() => escolher(e)} aria-label={e} className="flex size-9 items-center justify-center rounded text-xl hover:bg-superficie-2">
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
