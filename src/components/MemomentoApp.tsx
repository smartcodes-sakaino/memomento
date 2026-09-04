"use client";

/**
 * Memomento アプリ本体。
 *
 * 編集モデルは modelRef (可変) に保持し、文字入力では再レンダーしない。
 * ブロックの追加/削除/種類変更などの構造変化のみ structVersion を上げて
 * エディタ全体を再マウントする(プロトタイプと同じ描画戦略)。
 * ブロック各コンポーネントは memo(…, () => true) で親の再レンダーから切り離す。
 */

import Image from "next/image";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { escapeHtml, normalizeExternalUrl, syncLinkLabels } from "@/lib/wikilink";
import { HOME_PAGE_ID, MAX_LIST_LEVEL } from "@/lib/types";
import {
  apiCreatePage,
  apiDeletePage,
  apiExportNotebookLM,
  apiFetchAll,
  apiHealth,
  apiImportGoogleDoc,
  apiPatchPage,
  apiPutBlocks,
  apiUploadImage,
} from "./api";
import {
  fromServer,
  isTexty,
  seedModel,
  uid,
  type ClientBlock,
  type ClientPage,
  type Model,
  type TextyType,
} from "./model";

// ---------------------------------------------------------------- 定数

const BLOCK_TYPE_DEFS: { type: ClientBlock["type"]; label: string; glyph: string }[] = [
  { type: "heading1", label: "見出し 1", glyph: "H1" },
  { type: "heading2", label: "見出し 2", glyph: "H2" },
  { type: "paragraph", label: "本文", glyph: "¶" },
  { type: "checklist", label: "チェックリスト", glyph: "☑" },
  { type: "bulletlist", label: "箇条書きリスト", glyph: "•" },
  { type: "numberlist", label: "番号付きリスト", glyph: "1." },
  { type: "quote", label: "引用", glyph: "“" },
  { type: "code", label: "コード", glyph: "<>" },
  { type: "table", label: "表", glyph: "▦" },
  { type: "image", label: "画像", glyph: "IMG" },
];

const ICON_CHOICES = [
  "🗒️", "📝", "📓", "📚", "🎓", "🌐", "💡", "✅", "📌", "⭐", "🔖",
  "🧠", "💬", "📁", "🗂️", "👤", "📖", "🔧", "📅", "🚀", "🍀", "🎯",
];

const COLOR_SWATCHES = [
  { name: "既定", value: "" },
  { name: "ピンク", value: "#d16a86" },
  { name: "ブルー", value: "#37656b" },
  { name: "イエロー", value: "#8a6d1f" },
  { name: "レッド", value: "#ba1a1a" },
  { name: "グレー", value: "#6b5a52" },
];

type SaveState = "ok" | "saving" | "error" | "offline";

// ---------------------------------------------------------------- ユーティリティ

function placeCaretEnd(el: HTMLElement) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function newBlock(type: ClientBlock["type"]): ClientBlock {
  switch (type) {
    case "checklist":
      return { id: uid("b"), type, items: [{ id: uid("i"), text: "", done: false }] };
    case "bulletlist":
    case "numberlist":
      return { id: uid("b"), type, items: [{ id: uid("i"), text: "" }] };
    case "table":
      return { id: uid("b"), type, rows: [["", ""], ["", ""]] };
    case "image":
      return { id: uid("b"), type, src: "", caption: "" };
    default:
      return { id: uid("b"), type: type as TextyType, html: "" };
  }
}

/**
 * 選択メニュー・ブロックメニューをビューポート内に収まるよう位置調整する。
 * クリック位置(x, y)をそのまま fixed 配置すると、画面下端/右端付近で開いた
 * 場合にメニューが画面外にはみ出し、position: fixed のためスクロールしても
 * 二度と表示されない事故が起きていた。実寸を測って毎回クランプする。
 */
function ClampedMenu({
  x,
  y,
  className = "menu",
  children,
}: {
  x: number;
  y: number;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    el.style.left = `${Math.min(Math.max(x, margin), maxLeft)}px`;
    el.style.top = `${Math.min(Math.max(y, margin), maxTop)}px`;
  }, [x, y]);
  return (
    <div ref={ref} className={className} style={{ left: x, top: y }}>
      {children}
    </div>
  );
}

/** 要素自身だけを取り除き、中身(子ノード)はその場に残す(太字解除などに使う) */
function unwrapElement(el: HTMLElement) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function blockPlainText(b: ClientBlock): string {
  switch (b.type) {
    case "checklist":
    case "bulletlist":
    case "numberlist":
      return b.items.map((i) => i.text).join("\n");
    case "table":
      return b.rows.map((r) => r.join(" | ")).join("\n");
    case "image":
      return b.caption;
    default: {
      const tmp = document.createElement("div");
      tmp.innerHTML = b.html;
      return tmp.textContent ?? "";
    }
  }
}

// ---------------------------------------------------------------- アプリ本体

export default function MemomentoApp() {
  const modelRef = useRef<Model>(seedModel());
  const [ready, setReady] = useState(false);
  const [currentPageId, setCurrentPageId] = useState(HOME_PAGE_ID);
  const currentPageIdRef = useRef(currentPageId);
  currentPageIdRef.current = currentPageId;

  const [structVersion, setStructVersion] = useState(0);
  const [, setTreeVersion] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ home: true });
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("ok");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [nbOpen, setNbOpen] = useState(false);
  const [nbSelected, setNbSelected] = useState<Set<string>>(new Set());
  const [nbTitle, setNbTitle] = useState("");
  const [nbBusy, setNbBusy] = useState(false);
  const [health, setHealth] = useState<{ sheets: boolean; drive: boolean } | null>(null);
  const [toastMsg, setToastMsg] = useState("");

  type TypeMenuState = { x: number; y: number; blockId: string | null; insertBelow: boolean };
  type SelMenuState = {
    x: number;
    y: number;
    mode: "menu" | "link" | "extlink" | "callout";
    bold?: boolean;
  };
  type IconPickerState = { x: number; y: number; pageId: string };
  type CalloutState = { x: number; y: number; text: string };

  const [typeMenu, setTypeMenu] = useState<TypeMenuState | null>(null);
  const [selMenu, setSelMenu] = useState<SelMenuState | null>(null);
  const [iconPicker, setIconPicker] = useState<IconPickerState | null>(null);
  const [callout, setCallout] = useState<CalloutState | null>(null);

  const dragIdRef = useRef<string | null>(null);
  const imageTargetRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingRangeRef = useRef<Range | null>(null);
  const pendingContainerRef = useRef<HTMLElement | null>(null);
  const pendingBlockIdRef = useRef<string | null>(null);
  const pendingItemIdRef = useRef<string | null>(null);
  const blockSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pagePatchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const offlineRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bump = useCallback(() => setStructVersion((v) => v + 1), []);
  const bumpTree = useCallback(() => setTreeVersion((v) => v + 1), []);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(""), 2400);
  }, []);

  // ---------------- 初期読み込み ----------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { pages } = await apiFetchAll();
        if (cancelled) return;
        modelRef.current = fromServer(pages);
        offlineRef.current = false;
        setSaveState("ok");
      } catch {
        if (cancelled) return;
        offlineRef.current = true;
        setSaveState("offline");
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------------- モデルヘルパー ----------------
  const model = () => modelRef.current;
  const pageOf = (id: string): ClientPage | undefined => model().pages[id];
  const allPages = () => Object.values(model().pages);
  const findByTitle = (title: string) => allPages().find((p) => p.title === title);
  const titlesMap = () => new Map(allPages().map((p) => [p.id, p.title] as const));

  const breadcrumbChain = (id: string): ClientPage[] => {
    const chain: ClientPage[] = [];
    let cur = pageOf(id);
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? pageOf(cur.parentId) : undefined;
    }
    return chain;
  };

  const isDescendant = (ancestorId: string, nodeId: string): boolean => {
    let node = pageOf(nodeId);
    while (node?.parentId) {
      if (node.parentId === ancestorId) return true;
      node = pageOf(node.parentId);
    }
    return false;
  };

  const siblingsOf = (id: string): string[] => {
    const p = pageOf(id);
    if (!p) return model().rootOrder;
    return p.parentId ? pageOf(p.parentId)?.childOrder ?? [] : model().rootOrder;
  };

  const removeFromSiblings = (id: string) => {
    const arr = siblingsOf(id);
    const idx = arr.indexOf(id);
    if (idx !== -1) arr.splice(idx, 1);
  };

  // ---------------- 保存 ----------------
  const markSaved = useCallback((ok: boolean) => {
    if (offlineRef.current) {
      setSaveState("offline");
      return;
    }
    setSaveState(ok ? "ok" : "error");
  }, []);

  const flushBlockSave = useCallback(
    async (pageId: string) => {
      const timer = blockSaveTimers.current.get(pageId);
      if (timer) {
        clearTimeout(timer);
        blockSaveTimers.current.delete(pageId);
      }
      const page = modelRef.current.pages[pageId];
      if (!page || offlineRef.current) return;
      setSaveState("saving");
      try {
        await apiPutBlocks(pageId, page.blocks);
        markSaved(true);
      } catch (e) {
        markSaved(false);
        toast(e instanceof Error ? e.message : "保存に失敗しました");
      }
    },
    [markSaved, toast]
  );

  const scheduleBlockSave = useCallback(
    (pageId: string) => {
      const timers = blockSaveTimers.current;
      const prev = timers.get(pageId);
      if (prev) clearTimeout(prev);
      timers.set(
        pageId,
        setTimeout(() => flushBlockSave(pageId), 900)
      );
    },
    [flushBlockSave]
  );

  const patchPageRemote = useCallback(
    (pageId: string, patch: Parameters<typeof apiPatchPage>[1], debounceMs = 0) => {
      if (offlineRef.current) {
        setSaveState("offline");
        return;
      }
      const run = async () => {
        setSaveState("saving");
        try {
          await apiPatchPage(pageId, patch);
          markSaved(true);
        } catch (e) {
          markSaved(false);
          toast(e instanceof Error ? e.message : "保存に失敗しました");
        }
      };
      if (debounceMs === 0) {
        void run();
        return;
      }
      const timers = pagePatchTimers.current;
      const key = `${pageId}:${Object.keys(patch).join(",")}`;
      const prev = timers.get(key);
      if (prev) clearTimeout(prev);
      timers.set(key, setTimeout(run, debounceMs));
    },
    [markSaved, toast]
  );

  // ---------------- ページ操作 ----------------
  const selectPage = useCallback(
    (id: string) => {
      const prevId = currentPageIdRef.current;
      if (prevId !== id && blockSaveTimers.current.has(prevId)) {
        void flushBlockSave(prevId);
      }
      setTypeMenu(null);
      setSelMenu(null);
      setIconPicker(null);
      setCallout(null);
      setCurrentPageId(id);
    },
    [flushBlockSave]
  );

  const createNewPage = useCallback(
    async (parentId: string | null, title = ""): Promise<string> => {
      const m = modelRef.current;
      let id = uid("p");
      if (!offlineRef.current) {
        try {
          const { page } = await apiCreatePage({ title, parentId });
          id = page.id;
        } catch (e) {
          toast(e instanceof Error ? e.message : "ページ作成に失敗しました");
          markSaved(false);
        }
      }
      m.pages[id] = {
        id,
        title,
        parentId,
        childOrder: [],
        tags: [],
        icon: "🗒️",
        blocks: [],
      };
      if (parentId) {
        pageOf(parentId)?.childOrder.push(id);
        setExpanded((e) => ({ ...e, [parentId]: true }));
      } else {
        m.rootOrder.push(id);
      }
      bumpTree();
      return id;
    },
    [bumpTree, markSaved, toast]
  );

  const deletePage = useCallback(
    (id: string) => {
      const m = modelRef.current;
      const collect = (pid: string): string[] => {
        const p = m.pages[pid];
        if (!p) return [];
        return [pid, ...p.childOrder.flatMap(collect)];
      };
      const ids = collect(id);
      removeFromSiblings(id);
      for (const pid of ids) delete m.pages[pid];
      if (ids.includes(currentPageIdRef.current)) {
        setCurrentPageId(HOME_PAGE_ID);
      }
      bumpTree();
      bump();
      if (!offlineRef.current) {
        apiDeletePage(id).then(
          () => markSaved(true),
          (e) => {
            markSaved(false);
            toast(e instanceof Error ? e.message : "削除に失敗しました");
          }
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bump, bumpTree, markSaved, toast]
  );

  const reparentPage = useCallback(
    (draggedId: string, targetId: string) => {
      const m = modelRef.current;
      if (!m.pages[draggedId] || !m.pages[targetId] || draggedId === targetId) return;
      if (draggedId === HOME_PAGE_ID) {
        toast("ホームは移動できません");
        return;
      }
      if (isDescendant(draggedId, targetId)) {
        toast("その中には移動できません");
        return;
      }
      removeFromSiblings(draggedId);
      m.pages[draggedId].parentId = targetId;
      const kids = m.pages[targetId].childOrder;
      if (!kids.includes(draggedId)) kids.push(draggedId);
      setExpanded((e) => ({ ...e, [targetId]: true }));
      bumpTree();
      patchPageRemote(draggedId, { parentId: targetId, orderIndex: kids.length - 1 });
      toast(`「${m.pages[draggedId].title || "無題のページ"}」を移動しました`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bumpTree, patchPageRemote, toast]
  );

  const moveViaOrder = useCallback(
    (draggedId: string, targetId: string, mode: "before" | "after") => {
      const m = modelRef.current;
      if (!m.pages[draggedId] || !m.pages[targetId] || draggedId === targetId) return;
      if (draggedId === HOME_PAGE_ID) {
        toast("ホームは移動できません");
        return;
      }
      const targetParentId = m.pages[targetId].parentId;
      if (targetParentId && (targetParentId === draggedId || isDescendant(draggedId, targetParentId))) {
        toast("その位置には移動できません");
        return;
      }
      removeFromSiblings(draggedId);
      m.pages[draggedId].parentId = targetParentId;
      const arr = targetParentId ? m.pages[targetParentId].childOrder : m.rootOrder;
      let idx = arr.indexOf(targetId);
      if (idx === -1) idx = arr.length;
      if (mode === "after") idx += 1;
      arr.splice(idx, 0, draggedId);
      if (targetParentId) setExpanded((e) => ({ ...e, [targetParentId]: true }));
      bumpTree();
      patchPageRemote(draggedId, { parentId: targetParentId, orderIndex: idx });
      toast(`「${m.pages[draggedId].title || "無題のページ"}」の位置を変更しました`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bumpTree, patchPageRemote, toast]
  );

  const moveToRoot = useCallback(
    (draggedId: string) => {
      const m = modelRef.current;
      const p = m.pages[draggedId];
      if (!p || draggedId === HOME_PAGE_ID || p.parentId === null) return;
      removeFromSiblings(draggedId);
      p.parentId = null;
      m.rootOrder.push(draggedId);
      bumpTree();
      patchPageRemote(draggedId, { parentId: null, orderIndex: m.rootOrder.length - 1 });
      toast(`「${p.title || "無題のページ"}」をトップレベルに移動しました`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bumpTree, patchPageRemote, toast]
  );

  // ---------------- ブロック操作 ----------------
  const currentBlocks = () => pageOf(currentPageIdRef.current)?.blocks ?? [];

  /** checklist/bulletlist/numberlistブロックの中から項目を1つ探す */
  const findListItem = (
    blockId: string,
    itemId: string
  ): { id: string; text: string; level?: number } | null => {
    const b = currentBlocks().find((x) => x.id === blockId);
    if (!b || (b.type !== "checklist" && b.type !== "bulletlist" && b.type !== "numberlist")) return null;
    return b.items.find((it) => it.id === itemId) ?? null;
  };

  const focusBlock = useCallback((blockId: string) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-block-id="${blockId}"] .b-content, [data-block-id="${blockId}"] .chk-text, [data-block-id="${blockId}"] .list-text, [data-block-id="${blockId}"] .table-cell`
        );
        if (el) placeCaretEnd(el);
      });
    });
  }, []);

  const insertBlock = useCallback(
    (afterBlockId: string | null, type: ClientBlock["type"]) => {
      const blocks = currentBlocks();
      const idx = afterBlockId
        ? blocks.findIndex((b) => b.id === afterBlockId)
        : blocks.length - 1;
      const nb = newBlock(type);
      blocks.splice(idx + 1, 0, nb);
      bump();
      scheduleBlockSave(currentPageIdRef.current);
      focusBlock(nb.id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bump, focusBlock, scheduleBlockSave]
  );

  const changeBlockType = useCallback(
    (blockId: string, type: ClientBlock["type"]) => {
      const blocks = currentBlocks();
      const idx = blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;
      const old = blocks[idx];
      const text = blockPlainText(old);
      let fresh = newBlock(type);
      if (type === "checklist") {
        fresh = {
          id: old.id,
          type,
          items: (text ? text.split("\n").filter(Boolean) : [""]).map((t) => ({
            id: uid("i"),
            text: t,
            done: false,
          })),
        };
      } else if (type === "bulletlist" || type === "numberlist") {
        fresh = {
          id: old.id,
          type,
          items: (text ? text.split("\n").filter(Boolean) : [""]).map((t) => ({
            id: uid("i"),
            text: t,
          })),
        };
      } else if (type === "table") {
        fresh = { id: old.id, type, rows: [[text || ""]] };
      } else if (type === "image") {
        fresh = { id: old.id, type, src: "", caption: "" };
      } else {
        fresh = { id: old.id, type: type as TextyType, html: escapeHtml(text) };
      }
      blocks[idx] = fresh;
      bump();
      scheduleBlockSave(currentPageIdRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bump, scheduleBlockSave]
  );

  const deleteBlock = useCallback(
    (blockId: string) => {
      const blocks = currentBlocks();
      const idx = blocks.findIndex((b) => b.id === blockId);
      if (idx !== -1) blocks.splice(idx, 1);
      bump();
      scheduleBlockSave(currentPageIdRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bump, scheduleBlockSave]
  );

  // ---------------- wikiリンク ----------------
  const goToWikiTarget = useCallback(
    async (a: HTMLAnchorElement, containerEl: HTMLElement, blockId: string, itemId?: string) => {
      const pageId = a.getAttribute("data-page-id");
      if (pageId && pageOf(pageId)) {
        selectPage(pageId);
        return;
      }
      const title = a.getAttribute("data-title") ?? a.textContent ?? "";
      const existing = findByTitle(title);
      if (existing) {
        selectPage(existing.id);
        return;
      }
      // リンク先が無い場合はその場で作成し、リンクをID参照に書き換える
      const newId = await createNewPage(null, title);
      containerEl
        .querySelectorAll<HTMLAnchorElement>(`a.wikilink[data-title="${CSS.escape(title)}"]`)
        .forEach((el) => {
          el.removeAttribute("data-title");
          el.setAttribute("data-page-id", newId);
          el.classList.remove("is-new");
        });
      if (itemId) {
        const item = findListItem(blockId, itemId);
        if (item) {
          item.text = containerEl.innerHTML;
          scheduleBlockSave(currentPageIdRef.current);
        }
      } else {
        const blocks = currentBlocks();
        const b = blocks.find((x) => x.id === blockId);
        if (b && isTexty(b)) {
          b.html = containerEl.innerHTML;
          scheduleBlockSave(currentPageIdRef.current);
        }
      }
      toast(`新しいページ「${title}」を作成しました`);
      selectPage(newId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [createNewPage, scheduleBlockSave, selectPage, toast]
  );

  // 入力中の [[名前]] / **太字** / *斜体* / `コード` を装飾に変換する
  const autoConvertTrailing = useCallback((container: HTMLElement) => {
    const sel = window.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !container.contains(node)) return;
    if ((node.parentElement)?.closest("a, strong, em, code, .callout-inline")) return;

    const offset = sel.anchorOffset;
    const text = (node.textContent ?? "").slice(0, offset);

    const make = (
      re: RegExp,
      build: (m: RegExpExecArray) => HTMLElement,
      prefixed = false
    ): boolean => {
      const m = re.exec(text);
      if (!m) return false;
      const prefixLen = prefixed ? m[1].length : 0;
      const start = offset - m[0].length + prefixLen;
      const el = build(m);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, offset);
      range.deleteContents();
      range.insertNode(el);
      const spacer = document.createTextNode("​");
      el.parentNode?.insertBefore(spacer, el.nextSibling);
      const after = document.createRange();
      after.setStart(spacer, 1);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      return true;
    };

    make(/\[\[([^\[\]]+)\]\]$/, (m) => {
      const name = m[1].trim();
      const a = document.createElement("a");
      a.className = "wikilink";
      const existing = findByTitle(name);
      if (existing) {
        a.setAttribute("data-page-id", existing.id);
      } else {
        a.setAttribute("data-title", name);
        a.classList.add("is-new");
      }
      a.textContent = name;
      return a;
    }) ||
      make(/`([^`]+)`$/, (m) => {
        const el = document.createElement("code");
        el.textContent = m[1];
        return el;
      }) ||
      make(/\*\*([^*]+)\*\*$/, (m) => {
        const el = document.createElement("strong");
        el.textContent = m[1];
        return el;
      }) ||
      make(
        /(^|[^*])\*([^*]+)\*$/,
        (m) => {
          const el = document.createElement("em");
          el.textContent = m[2];
          return el;
        },
        true
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- 選択範囲メニュー ----------------
  const openSelMenu = useCallback(
    (x: number, y: number, container: HTMLElement, blockId: string, range: Range, itemId?: string) => {
      pendingRangeRef.current = range.cloneRange();
      pendingContainerRef.current = container;
      pendingBlockIdRef.current = blockId;
      pendingItemIdRef.current = itemId ?? null;
      setSelMenu({ x, y, mode: "menu", bold: document.queryCommandState("bold") });
    },
    []
  );

  /** 選択範囲の変更(装飾の追加など)を、リスト項目/通常ブロックそれぞれの保存先に反映する */
  const commitPendingSelectionChange = useCallback(
    (container: HTMLElement, blockId: string, itemId: string | null) => {
      if (itemId) {
        const item = findListItem(blockId, itemId);
        if (item) {
          item.text = container.innerHTML;
          scheduleBlockSave(currentPageIdRef.current);
        }
      } else {
        const blocks = currentBlocks();
        const b = blocks.find((x) => x.id === blockId);
        if (b && isTexty(b)) {
          b.html = container.innerHTML;
          scheduleBlockSave(currentPageIdRef.current);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scheduleBlockSave]
  );

  const applyWrap = useCallback(
    (wrapper: HTMLElement) => {
      const range = pendingRangeRef.current;
      const container = pendingContainerRef.current;
      const blockId = pendingBlockIdRef.current;
      const itemId = pendingItemIdRef.current;
      if (!range || !container || !blockId) return;
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      try {
        range.surroundContents(wrapper);
      } catch {
        const frag = range.extractContents();
        wrapper.appendChild(frag);
        range.insertNode(wrapper);
      }
      sel?.removeAllRanges();
      commitPendingSelectionChange(container, blockId, itemId);
      pendingRangeRef.current = null;
      pendingContainerRef.current = null;
      pendingBlockIdRef.current = null;
      pendingItemIdRef.current = null;
      setSelMenu(null);
    },
    [commitPendingSelectionChange]
  );

  /**
   * 太字のオン/オフを切り替える。既存のapplyWrapは常に新しい<strong>で包むだけで
   * 解除ができなかったため、選択範囲が既に太字なら取り除く側に倒す。
   * 選択範囲が<strong>要素の途中(テキストノードの一部)に収まっている場合、
   * 単純にrange.extractContentsしただけでは<strong>要素自体は残ってしまう
   * (要素の「外」に出るには祖先を分割する必要があるため)。この分割処理は
   * 複雑でバグを生みやすいので、代わりに「選択範囲に重なる<strong>/<b>要素を
   * 丸ごと解除する」という簡易な仕様にする(部分的な選択でも、その選択を含む
   * 太字のかたまり全体が解除される)。
   */
  const toggleBold = useCallback(() => {
    const range = pendingRangeRef.current;
    const container = pendingContainerRef.current;
    const blockId = pendingBlockIdRef.current;
    const itemId = pendingItemIdRef.current;
    if (!range || !container || !blockId) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    if (!document.queryCommandState("bold")) {
      applyWrap(document.createElement("strong"));
      return;
    }
    const boldEls = Array.from(container.querySelectorAll("strong, b")) as HTMLElement[];
    const overlapping = boldEls.filter((el) => range.intersectsNode(el));
    for (let i = overlapping.length - 1; i >= 0; i--) unwrapElement(overlapping[i]);
    sel?.removeAllRanges();
    commitPendingSelectionChange(container, blockId, itemId);
    pendingRangeRef.current = null;
    pendingContainerRef.current = null;
    pendingBlockIdRef.current = null;
    pendingItemIdRef.current = null;
    setSelMenu(null);
  }, [applyWrap, commitPendingSelectionChange]);

  // ---------------- 画像 ----------------
  const onImageFileSelected = useCallback(
    async (file: File) => {
      const blockId = imageTargetRef.current;
      imageTargetRef.current = null;
      if (!blockId) return;
      const blocks = currentBlocks();
      const b = blocks.find((x) => x.id === blockId);
      if (!b || b.type !== "image") return;

      if (offlineRef.current) {
        toast("未接続のため画像をアップロードできません");
        return;
      }
      b.uploading = true;
      bump();
      try {
        const { url } = await apiUploadImage(file);
        b.src = url;
        b.uploading = false;
        bump();
        scheduleBlockSave(currentPageIdRef.current);
        toast("画像をGoogle Driveに保存しました");
      } catch (e) {
        b.uploading = false;
        bump();
        toast(e instanceof Error ? e.message : "画像のアップロードに失敗しました");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bump, scheduleBlockSave, toast]
  );

  // ---------------- ポップオーバーの外側クリック ----------------
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const path = e.composedPath();
      const inside = (selector: string) =>
        path.some((el) => el instanceof HTMLElement && el.matches?.(selector));
      if (typeMenu && !inside(".menu")) setTypeMenu(null);
      if (selMenu && !inside(".menu")) setSelMenu(null);
      if (iconPicker && !inside(".icon-picker") && !inside(".row-icon") && !inside(".title-icon-big"))
        setIconPicker(null);
      if (callout && !inside(".callout-pop") && !inside(".callout-inline")) setCallout(null);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [typeMenu, selMenu, iconPicker, callout]);

  // 設定パネルを開いたときに接続状況を確認する
  useEffect(() => {
    if (!settingsOpen) return;
    setHealth(null);
    apiHealth().then(setHealth, () => setHealth({ sheets: false, drive: false }));
  }, [settingsOpen]);

  // ---------------- レンダリング ----------------
  if (!ready) {
    return (
      <div className="loading-screen">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-tagline.png" alt="Memomento — 日々の小さな瞬間をメモに" />
        <div>読み込んでいます…</div>
      </div>
    );
  }

  const m = model();
  const currentPage = pageOf(currentPageId) ?? pageOf(HOME_PAGE_ID)!;
  const allTags = [...new Set(allPages().flatMap((p) => p.tags))].sort();
  const filtering = searchQuery.trim() !== "" || activeTag !== null;

  const matchesFilter = (p: ClientPage) => {
    const q = searchQuery.trim().toLowerCase();
    const qOk = !q || p.title.toLowerCase().includes(q);
    const tOk = !activeTag || p.tags.includes(activeTag);
    return qOk && tOk;
  };

  const saveLabels: Record<SaveState, { label: string; cls: string }> = {
    ok: { label: "スプレッドシートに保存済み", cls: "ok" },
    saving: { label: "保存中…", cls: "saving" },
    error: { label: "保存エラー(再編集で再試行)", cls: "error" },
    offline: { label: "未接続(ローカル編集中)", cls: "error" },
  };

  // ---- サイドバーの行(再帰) ----
  const TreeRow = ({ page, depth }: { page: ClientPage; depth: number }) => {
    const [dropMode, setDropMode] = useState<"before" | "after" | "inside" | null>(null);
    const [armed, setArmed] = useState(false);
    const hasChildren = page.childOrder.length > 0;
    const isExpanded = expanded[page.id] ?? false;

    return (
      <div>
        <div
          className={
            "tree-row" +
            (page.id === currentPageId ? " active" : "") +
            (dropMode ? ` drop-${dropMode}` : "")
          }
          draggable
          onClick={() => selectPage(page.id)}
          onDragStart={(e) => {
            dragIdRef.current = page.id;
            e.dataTransfer.setData("text/plain", page.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            dragIdRef.current = null;
            setDropMode(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const rect = e.currentTarget.getBoundingClientRect();
            const rel = (e.clientY - rect.top) / rect.height;
            setDropMode(rel < 0.3 ? "before" : rel > 0.7 ? "after" : "inside");
          }}
          onDragLeave={() => setDropMode(null)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const mode = dropMode ?? "inside";
            setDropMode(null);
            const draggedId = e.dataTransfer.getData("text/plain") || dragIdRef.current;
            if (!draggedId) return;
            if (mode === "inside") reparentPage(draggedId, page.id);
            else moveViaOrder(draggedId, page.id, mode);
          }}
        >
          <div
            className={"chev" + (hasChildren && !isExpanded ? " collapsed" : "")}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((ex) => ({ ...ex, [page.id]: !isExpanded }));
            }}
          >
            {hasChildren && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            )}
          </div>
          <div
            className="row-icon"
            title="アイコンを変更"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setIconPicker({ x: r.left, y: r.bottom + 4, pageId: page.id });
            }}
          >
            {page.icon}
          </div>
          <div className="title">{page.title || "無題のページ"}</div>
          <div className="row-actions">
            <button
              className="icon-btn"
              title="サブページを追加"
              onClick={async (e) => {
                e.stopPropagation();
                const id = await createNewPage(page.id);
                selectPage(id);
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            {page.id !== HOME_PAGE_ID && (
              <button
                className="icon-btn"
                title={armed ? "もう一度クリックで削除" : "削除(2回クリック)"}
                style={armed ? { color: "var(--error)" } : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (armed) deletePage(page.id);
                  else {
                    setArmed(true);
                    setTimeout(() => setArmed(false), 2500);
                  }
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {hasChildren && isExpanded && (
          <div className="tree-children">
            {page.childOrder.map((cid) => {
              const cp = pageOf(cid);
              return cp ? <TreeRow key={cid} page={cp} depth={depth + 1} /> : null;
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="app">
      {/* ================= サイドバー ================= */}
      <aside className="sidebar">
        <div className="brand">
          <Image src="/logo-banner.png" alt="Memomento" width={420} height={94} priority />
        </div>
        <div className="search-wrap">
          <div className="search-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="ページを検索"
              autoComplete="off"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="tag-rail">
          {allTags.map((t) => (
            <div
              key={t}
              className={"tag-chip" + (activeTag === t ? " active" : "")}
              onClick={() => setActiveTag(activeTag === t ? null : t)}
            >
              #{t}
            </div>
          ))}
        </div>
        <div className="tree-head">
          <span>
            ページ <span className="hint">(ドラッグで移動)</span>
          </span>
          <button
            className="icon-btn"
            title="新規ページ"
            onClick={async () => {
              const id = await createNewPage(null);
              selectPage(id);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
        <div className="tree">
          {filtering ? (
            (() => {
              const matches = allPages().filter(matchesFilter);
              if (matches.length === 0) return <div className="tree-empty">見つかりませんでした</div>;
              return matches.map((p) => (
                <div
                  key={p.id}
                  className={"tree-row" + (p.id === currentPageId ? " active" : "")}
                  onClick={() => selectPage(p.id)}
                >
                  <div className="row-icon">{p.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="title">{p.title || "無題のページ"}</div>
                    <span className="path-sub">
                      {breadcrumbChain(p.id).slice(0, -1).map((c) => c.title).join(" / ") || "トップレベル"}
                    </span>
                  </div>
                </div>
              ));
            })()
          ) : (
            <>
              <div
                style={{ minHeight: 6 }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const draggedId = e.dataTransfer.getData("text/plain") || dragIdRef.current;
                  if (draggedId) moveToRoot(draggedId);
                }}
              />
              {m.rootOrder.map((id) => {
                const p = pageOf(id);
                return p ? <TreeRow key={id} page={p} depth={0} /> : null;
              })}
            </>
          )}
        </div>
        <button
          className="new-page-btn"
          onClick={async () => {
            const id = await createNewPage(null);
            selectPage(id);
          }}
        >
          ＋ 新規ページ
        </button>
        <div className="sidebar-foot">
          <div className="sync-status">
            <span className={`dot ${saveLabels[saveState].cls}`} />
            {saveLabels[saveState].label}
          </div>
          <button className="icon-btn" title="設定" onClick={() => setSettingsOpen(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </aside>

      {/* ================= メイン ================= */}
      <main className="main">
        <div className="topbar">
          <div className="breadcrumb">
            {breadcrumbChain(currentPageId).map((p, i) => (
              <span key={p.id} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                {i > 0 && <span className="sep">/</span>}
                <span className="crumb" onClick={() => selectPage(p.id)}>
                  {p.icon} {p.title || "無題のページ"}
                </span>
              </span>
            ))}
          </div>
          <button
            className="ghost-btn"
            onClick={async () => {
              const id = await createNewPage(currentPageId);
              selectPage(id);
            }}
          >
            ＋ サブページを追加
          </button>
          <button
            className="ghost-btn"
            onClick={() => {
              setImportUrl("");
              setImportOpen(true);
            }}
          >
            📄 Googleドキュメントから追加
          </button>
        </div>
        <div className="editor-scroll">
          <div className="paper">
            <Editor
              key={`${currentPageId}:${structVersion}`}
              page={currentPage}
              titles={titlesMap()}
              onTitleInput={(title) => {
                currentPage.title = title;
                bumpTree();
                patchPageRemote(currentPage.id, { title }, 800);
              }}
              onIconClick={(x, y) => setIconPicker({ x, y, pageId: currentPage.id })}
              onAddTag={(tag) => {
                if (!currentPage.tags.includes(tag)) {
                  currentPage.tags.push(tag);
                  bumpTree();
                  bump();
                  patchPageRemote(currentPage.id, { tags: currentPage.tags });
                }
              }}
              onTextInput={(blockId, container) => {
                const b = currentBlocks().find((x) => x.id === blockId);
                if (b && b.type !== "code") autoConvertTrailing(container);
                if (b && isTexty(b)) b.html = container.innerHTML;
                scheduleBlockSave(currentPage.id);
              }}
              onTextEnter={(blockId) => {
                const b = currentBlocks().find((x) => x.id === blockId);
                const nextType =
                  b && (b.type === "heading1" || b.type === "heading2") ? "paragraph" : b?.type ?? "paragraph";
                insertBlock(blockId, nextType as ClientBlock["type"]);
              }}
              onTextBackspace={(blockId, container) => {
                const blocks = currentBlocks();
                const idx = blocks.findIndex((x) => x.id === blockId);
                if (idx <= 0) return;
                const prev = blocks[idx - 1];
                const current = blocks[idx];
                if (!isTexty(prev) || !isTexty(current)) return;
                const currentHtml = container.innerHTML;
                const prevWasPlain = !/<[a-z][\s\S]*>/i.test(prev.html);
                const mergeAt = prevWasPlain ? prev.html.length : 0;
                prev.html = prev.html + currentHtml;
                blocks.splice(idx, 1);
                bump();
                scheduleBlockSave(currentPage.id);
                focusTextBlockAt(prev.id, mergeAt);
              }}
              onWikilinkClick={(a, container, blockId, itemId) =>
                void goToWikiTarget(a, container, blockId, itemId)
              }
              onCalloutClick={(el) => {
                const r = el.getBoundingClientRect();
                setCallout({ x: r.left, y: r.bottom + 8, text: el.getAttribute("data-note") ?? "(メモなし)" });
              }}
              onContextSelection={(x, y, container, blockId, itemId) => {
                const sel = window.getSelection();
                if (sel?.rangeCount && !sel.isCollapsed) {
                  openSelMenu(x, y, container, blockId, sel.getRangeAt(0), itemId);
                }
              }}
              onOpenTypeMenu={(x, y, blockId, insertBelow) =>
                setTypeMenu({ x, y, blockId, insertBelow })
              }
              onStructuralChange={() => {
                bump();
                scheduleBlockSave(currentPage.id);
              }}
              onSoftChange={() => scheduleBlockSave(currentPage.id)}
              onImagePick={(blockId) => {
                imageTargetRef.current = blockId;
                fileInputRef.current?.click();
              }}
              onAddBlockEnd={() => {
                const blocks = currentBlocks();
                insertBlock(blocks.length ? blocks[blocks.length - 1].id : null, "paragraph");
              }}
            />
          </div>
        </div>
      </main>

      {/* ================= ポップオーバー ================= */}
      {typeMenu && (
        <ClampedMenu x={typeMenu.x} y={typeMenu.y}>
          {BLOCK_TYPE_DEFS.map((bt) => (
            <div
              key={bt.type}
              className="menu-item"
              onClick={() => {
                const t = typeMenu;
                setTypeMenu(null);
                if (t.insertBelow) insertBlock(t.blockId, bt.type);
                else if (t.blockId) changeBlockType(t.blockId, bt.type);
              }}
            >
              <span className="glyph">{bt.glyph}</span>
              <span>{bt.label}</span>
            </div>
          ))}
          {!typeMenu.insertBelow && typeMenu.blockId && (
            <>
              <div className="menu-sep" />
              <div
                className="menu-item danger"
                onClick={() => {
                  const id = typeMenu.blockId!;
                  setTypeMenu(null);
                  deleteBlock(id);
                }}
              >
                <span className="glyph">×</span>
                <span>このブロックを削除</span>
              </div>
            </>
          )}
        </ClampedMenu>
      )}

      {selMenu && (
        <ClampedMenu x={selMenu.x} y={selMenu.y}>
          {selMenu.mode === "menu" && (
            <>
              <div className="menu-item" onClick={toggleBold}>
                <span className="glyph">B</span>
                <span>{selMenu.bold ? "太字を解除" : "太字にする"}</span>
              </div>
              <div className="menu-label">文字色</div>
              <div className="swatch-row">
                {COLOR_SWATCHES.map((sw) => (
                  <button
                    key={sw.name}
                    className="swatch"
                    title={sw.name}
                    style={{
                      background: sw.value || "var(--surface-low)",
                      boxShadow: sw.value ? "none" : "inset 0 0 0 1px var(--outline-variant)",
                    }}
                    onClick={() => {
                      const span = document.createElement("span");
                      // 「既定」も明示的に標準の文字色を指定する(空のままだと、既に
                      // 色付けされた親要素の中では色が上書きされず戻らないため)
                      span.style.color = sw.value || "var(--ink)";
                      applyWrap(span);
                    }}
                  />
                ))}
              </div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={() => setSelMenu({ ...selMenu, mode: "link" })}>
                <span className="glyph">🔗</span>
                <span>リンクにする</span>
              </div>
              <div className="menu-item" onClick={() => setSelMenu({ ...selMenu, mode: "extlink" })}>
                <span className="glyph">↗</span>
                <span>外部リンクにする</span>
              </div>
              <div className="menu-item" onClick={() => setSelMenu({ ...selMenu, mode: "callout" })}>
                <span className="glyph">💬</span>
                <span>吹き出しを付ける</span>
              </div>
            </>
          )}
          {selMenu.mode === "link" && (
            <SelInputForm
              placeholder="ページ名"
              confirmLabel="リンク作成"
              initial={pendingRangeRef.current?.toString() ?? ""}
              onConfirm={(val) => {
                const a = document.createElement("a");
                a.className = "wikilink";
                const existing = findByTitle(val);
                if (existing) a.setAttribute("data-page-id", existing.id);
                else {
                  a.setAttribute("data-title", val);
                  a.classList.add("is-new");
                }
                applyWrap(a);
              }}
              onCancel={() => setSelMenu(null)}
            />
          )}
          {selMenu.mode === "extlink" && (
            <SelInputForm
              placeholder="https://example.com"
              confirmLabel="リンク作成"
              initial=""
              onConfirm={(val) => {
                const url = normalizeExternalUrl(val);
                if (!url) {
                  toast("URLの形式が正しくありません");
                  return;
                }
                const a = document.createElement("a");
                a.className = "ext-link";
                a.setAttribute("href", url);
                a.setAttribute("target", "_blank");
                a.setAttribute("rel", "noopener noreferrer");
                applyWrap(a);
              }}
              onCancel={() => setSelMenu(null)}
            />
          )}
          {selMenu.mode === "callout" && (
            <SelInputForm
              placeholder="吹き出しに表示するメモ"
              confirmLabel="吹き出しを作成"
              initial=""
              onConfirm={(val) => {
                const span = document.createElement("span");
                span.className = "callout-inline";
                span.setAttribute("data-note", val);
                applyWrap(span);
              }}
              onCancel={() => setSelMenu(null)}
            />
          )}
        </ClampedMenu>
      )}

      {iconPicker && (
        <div className="icon-picker" style={{ left: iconPicker.x, top: iconPicker.y }}>
          {ICON_CHOICES.map((ic) => (
            <button
              key={ic}
              onClick={() => {
                const p = pageOf(iconPicker.pageId);
                if (p) {
                  p.icon = ic;
                  bumpTree();
                  bump();
                  patchPageRemote(p.id, { icon: ic });
                }
                setIconPicker(null);
              }}
            >
              {ic}
            </button>
          ))}
        </div>
      )}

      {callout && (
        <div className="callout-pop" style={{ left: callout.x, top: callout.y }}>
          {callout.text}
        </div>
      )}

      {/* ================= 設定パネル ================= */}
      <div className={"scrim" + (settingsOpen ? " open" : "")} onClick={() => setSettingsOpen(false)} />
      <div className={"panel" + (settingsOpen ? " open" : "")}>
        <div className="panel-head">
          <h2>設定</h2>
          <button className="icon-btn" onClick={() => setSettingsOpen(false)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="panel-body">
          <div>
            <div className="panel-section-label">保存先の接続状況</div>
            <div className="status-card">
              <div>Google スプレッドシート(本文)</div>
              {health === null ? (
                <span className="status-pill">確認中…</span>
              ) : (
                <span className={"status-pill " + (health.sheets ? "ok" : "ng")}>
                  {health.sheets ? "接続済み" : "未接続"}
                </span>
              )}
            </div>
            <div className="status-card">
              <div>Google Drive(画像)</div>
              {health === null ? (
                <span className="status-pill">確認中…</span>
              ) : (
                <span className={"status-pill " + (health.drive ? "ok" : "ng")}>
                  {health.drive ? "接続済み" : "未接続"}
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="panel-section-label">バックアップ</div>
            <button
              className="primary-btn"
              onClick={() => {
                const a = document.createElement("a");
                a.href = "/api/export";
                a.download = "";
                document.body.appendChild(a);
                a.click();
                a.remove();
                toast("バックアップをダウンロードしています");
              }}
            >
              今すぐエクスポート
            </button>
            <p className="panel-note">
              全データ(ページとブロック)をJSONファイルとしてこのPCにダウンロードします。
            </p>
          </div>
          <div>
            <div className="panel-section-label">NotebookLM用ソース</div>
            <button
              className="primary-btn"
              onClick={() => {
                setNbSelected(new Set());
                setNbTitle("");
                setNbOpen(true);
              }}
            >
              ページを選んで作成
            </button>
            <p className="panel-note">
              選んだページの内容を整形し、新しいGoogleドキュメントとしてMemomentoフォルダに作成します(既存のドキュメントは上書きしません)。作成後、NotebookLMの「ソースを追加」→「Google Drive」からこのドキュメントを選べます。
            </p>
          </div>
        </div>
      </div>

      {/* ================= Googleドキュメント取り込みモーダル ================= */}
      {importOpen && (
        <>
          <div className="modal-scrim" onClick={() => !importBusy && setImportOpen(false)} />
          <div className="modal">
            <div className="modal-head">
              <h2>Googleドキュメントから追加</h2>
              <button className="icon-btn" onClick={() => !importBusy && setImportOpen(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <p className="panel-note">
                取り込みたいGoogleドキュメントのURL(またはID)を入力してください。「{currentPage.title || "無題のページ"}
                」の下に新しいページとして追加されます。見出し・箇条書き・番号付きリスト・表は保たれますが、それ以外の書式(色や画像など)は取り込まれません。
              </p>
              <div className="nb-title-row">
                <label className="panel-section-label" htmlFor="import-url-input">
                  GoogleドキュメントのURL
                </label>
                <input
                  id="import-url-input"
                  type="text"
                  className="nb-title-input"
                  placeholder="https://docs.google.com/document/d/..."
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                />
              </div>
              <p className="panel-note">
                事前に、このドキュメントを「リンクを知っている全員(閲覧者)」に共有しておいてください。
              </p>
            </div>
            <div className="modal-foot">
              <button className="ghost-btn" disabled={importBusy} onClick={() => setImportOpen(false)}>
                キャンセル
              </button>
              <button
                className="primary-btn"
                disabled={importBusy || !importUrl.trim()}
                onClick={async () => {
                  setImportBusy(true);
                  try {
                    const { page: imported } = await apiImportGoogleDoc({
                      docUrlOrId: importUrl.trim(),
                      parentId: currentPageId,
                    });
                    const { pages } = await apiFetchAll();
                    modelRef.current = fromServer(pages);
                    offlineRef.current = false;
                    setExpanded((ex) => ({ ...ex, [currentPageId]: true }));
                    setImportOpen(false);
                    toast(`「${imported.title || "無題のページ"}」を取り込みました`);
                    selectPage(imported.id);
                  } catch (e) {
                    toast(e instanceof Error ? e.message : "取り込みに失敗しました");
                  } finally {
                    setImportBusy(false);
                  }
                }}
              >
                {importBusy ? "取り込み中…" : "取り込む"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ================= NotebookLM用ページ選択モーダル ================= */}
      {nbOpen && (
        <>
          <div className="modal-scrim" onClick={() => !nbBusy && setNbOpen(false)} />
          <div className="modal">
            <div className="modal-head">
              <h2>NotebookLM用ソースを作成</h2>
              <button className="icon-btn" onClick={() => !nbBusy && setNbOpen(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <p className="panel-note">書き出したいページにチェックを付けてください(複数選択可)。</p>
              <div className="nb-tree">
                {m.rootOrder.map((id) => {
                  const p = pageOf(id);
                  return p ? (
                    <NbTreeRow
                      key={id}
                      page={p}
                      pageOf={pageOf}
                      selected={nbSelected}
                      onToggle={(id2) =>
                        setNbSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(id2)) next.delete(id2);
                          else next.add(id2);
                          return next;
                        })
                      }
                    />
                  ) : null;
                })}
              </div>
              <div className="nb-title-row">
                <label className="panel-section-label" htmlFor="nb-title-input">
                  ドキュメント名(空欄で自動生成)
                </label>
                <input
                  id="nb-title-input"
                  type="text"
                  className="nb-title-input"
                  placeholder="例: Memomento - 学習ノート"
                  value={nbTitle}
                  onChange={(e) => setNbTitle(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button className="ghost-btn" disabled={nbBusy} onClick={() => setNbOpen(false)}>
                キャンセル
              </button>
              <button
                className="primary-btn"
                disabled={nbBusy || nbSelected.size === 0}
                onClick={async () => {
                  setNbBusy(true);
                  try {
                    const { url } = await apiExportNotebookLM(
                      Array.from(nbSelected),
                      nbTitle.trim() || undefined
                    );
                    toast("NotebookLM用ドキュメントを作成しました");
                    setNbOpen(false);
                    window.open(url, "_blank", "noopener");
                  } catch (e) {
                    toast(e instanceof Error ? e.message : "作成に失敗しました");
                  } finally {
                    setNbBusy(false);
                  }
                }}
              >
                {nbBusy ? "作成中…" : `作成(${nbSelected.size}件)`}
              </button>
            </div>
          </div>
        </>
      )}

      <div className={"toast" + (toastMsg ? " show" : "")}>{toastMsg}</div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void onImageFileSelected(file);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- NotebookLM用ページ選択ツリー

function NbTreeRow({
  page,
  pageOf,
  selected,
  onToggle,
}: {
  page: ClientPage;
  pageOf: (id: string) => ClientPage | undefined;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="nb-row">
      <label className="nb-row-label">
        <input type="checkbox" checked={selected.has(page.id)} onChange={() => onToggle(page.id)} />
        <span className="nb-row-icon">{page.icon}</span>
        <span>{page.title || "無題のページ"}</span>
      </label>
      {page.childOrder.length > 0 && (
        <div className="nb-children">
          {page.childOrder.map((cid) => {
            const cp = pageOf(cid);
            return cp ? (
              <NbTreeRow key={cid} page={cp} pageOf={pageOf} selected={selected} onToggle={onToggle} />
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 選択メニューの入力フォーム

function SelInputForm({
  placeholder,
  confirmLabel,
  initial,
  onConfirm,
  onCancel,
}: {
  placeholder: string;
  confirmLabel: string;
  initial: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="menu-input-row">
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (value.trim()) onConfirm(value.trim());
          }
          if (e.key === "Escape") onCancel();
        }}
      />
      <button onClick={() => value.trim() && onConfirm(value.trim())}>{confirmLabel}</button>
    </div>
  );
}

// ---------------------------------------------------------------- エディタ

interface EditorProps {
  page: ClientPage;
  titles: Map<string, string>;
  onTitleInput: (title: string) => void;
  onIconClick: (x: number, y: number) => void;
  onAddTag: (tag: string) => void;
  onTextInput: (blockId: string, container: HTMLElement) => void;
  onTextEnter: (blockId: string) => void;
  onTextBackspace: (blockId: string, container: HTMLElement) => void;
  onWikilinkClick: (a: HTMLAnchorElement, container: HTMLElement, blockId: string, itemId?: string) => void;
  onCalloutClick: (el: HTMLElement) => void;
  onContextSelection: (x: number, y: number, container: HTMLElement, blockId: string, itemId?: string) => void;
  onOpenTypeMenu: (x: number, y: number, blockId: string | null, insertBelow: boolean) => void;
  onStructuralChange: () => void;
  onSoftChange: () => void;
  onImagePick: (blockId: string) => void;
  onAddBlockEnd: () => void;
}

/** エディタ全体。key で再マウントされる前提のため、memoで親の再レンダーから遮断する */
const Editor = memo(function EditorInner(props: EditorProps) {
  const { page } = props;
  const [tagOpen, setTagOpen] = useState(false);
  const [tagValue, setTagValue] = useState("");
  const titleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (titleRef.current) titleRef.current.textContent = page.title;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="title-row">
        <div
          className="title-icon-big"
          title="アイコンを変更"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            props.onIconClick(r.left, r.bottom + 4);
          }}
        >
          {page.icon}
        </div>
        <div
          ref={titleRef}
          className="page-title"
          contentEditable
          suppressContentEditableWarning
          data-placeholder="無題のページ"
          onInput={(e) => props.onTitleInput(e.currentTarget.textContent ?? "")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLElement).blur();
            }
          }}
        />
      </div>

      <div className="page-tags">
        {page.tags.map((t) => (
          <span key={t} className="page-tag">
            #{t}
          </span>
        ))}
        <div className={"add-tag" + (tagOpen ? " open" : "")}>
          <button onClick={() => setTagOpen(true)}>＋</button>
          <input
            type="text"
            placeholder="タグ名"
            value={tagValue}
            onChange={(e) => setTagValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && tagValue.trim()) {
                props.onAddTag(tagValue.trim());
                setTagValue("");
                setTagOpen(false);
              }
              if (e.key === "Escape") {
                setTagValue("");
                setTagOpen(false);
              }
            }}
            onBlur={() => {
              if (!tagValue) setTagOpen(false);
            }}
          />
        </div>
      </div>

      <div>
        {page.blocks.map((b) => (
          <BlockView key={b.id} block={b} editor={props} />
        ))}
      </div>
      <button className="add-block-btn" onClick={props.onAddBlockEnd}>
        ＋ ブロックを追加
      </button>
    </>
  );
}, () => true);

// ---------------------------------------------------------------- 各ブロック

function BlockControls({
  blockId,
  onOpenTypeMenu,
}: {
  blockId: string;
  onOpenTypeMenu: EditorProps["onOpenTypeMenu"];
}) {
  return (
    <div className="block-controls">
      <button
        title="下にブロックを追加"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onOpenTypeMenu(r.left, r.bottom + 4, blockId, true);
        }}
      >
        +
      </button>
      <button
        title="ブロックの種類を変更・削除"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onOpenTypeMenu(r.left, r.bottom + 4, blockId, false);
        }}
      >
        ⋮
      </button>
    </div>
  );
}

function placeholderFor(type: TextyType): string {
  if (type === "heading1") return "見出し 1";
  if (type === "heading2") return "見出し 2";
  if (type === "quote") return "引用を入力";
  if (type === "code") return "コードを入力";
  return "入力するか「[[ページ名]]」でリンク、Enterで改ブロック";
}

const BlockView = memo(function BlockViewInner({
  block,
  editor,
}: {
  block: ClientBlock;
  editor: EditorProps;
}) {
  switch (block.type) {
    case "checklist":
      return <ChecklistView block={block} editor={editor} />;
    case "bulletlist":
    case "numberlist":
      return <ListView block={block} editor={editor} />;
    case "table":
      return <TableView block={block} editor={editor} />;
    case "image":
      return <ImageView block={block} editor={editor} />;
    default:
      return <TextBlockView block={block} editor={editor} />;
  }
}, () => true);

function TextBlockView({
  block,
  editor,
}: {
  block: Extract<ClientBlock, { html: string }>;
  editor: EditorProps;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = syncLinkLabels(block.html, editor.titles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`block-row b-${block.type}`} data-block-id={block.id}>
      <BlockControls blockId={block.id} onOpenTypeMenu={editor.onOpenTypeMenu} />
      <div className="block-body">
        <div
          ref={ref}
          className="b-content"
          contentEditable
          suppressContentEditableWarning
          data-placeholder={placeholderFor(block.type)}
          onInput={() => ref.current && editor.onTextInput(block.id, ref.current)}
          onBlur={() => ref.current && editor.onTextInput(block.id, ref.current)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && block.type !== "code") {
              e.preventDefault();
              if (ref.current) editor.onTextInput(block.id, ref.current);
              editor.onTextEnter(block.id);
              return;
            }
            if (e.key === "Backspace" && ref.current && isCaretAtVeryStart(ref.current)) {
              e.preventDefault();
              editor.onTextBackspace(block.id, ref.current);
            }
          }}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            const link = target.closest?.("a.wikilink");
            if (link && ref.current) {
              e.preventDefault();
              e.stopPropagation();
              editor.onWikilinkClick(link as HTMLAnchorElement, ref.current, block.id);
              return;
            }
            const extLink = target.closest?.("a.ext-link") as HTMLAnchorElement | null;
            if (extLink) {
              e.preventDefault();
              e.stopPropagation();
              window.open(extLink.href, "_blank", "noopener,noreferrer");
              return;
            }
            const co = target.closest?.(".callout-inline");
            if (co) {
              e.preventDefault();
              e.stopPropagation();
              editor.onCalloutClick(co as HTMLElement);
            }
          }}
          onContextMenu={(e) => {
            if (block.type === "code") return;
            const sel = window.getSelection();
            if (sel?.rangeCount && !sel.isCollapsed && ref.current?.contains(sel.anchorNode)) {
              e.preventDefault();
              editor.onContextSelection(e.clientX, e.clientY, ref.current, block.id);
            }
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- リスト共通(Tab階層変更・十字キー移動)

function placeCaretInField(el: HTMLElement, offset: number) {
  el.focus();
  const node = el.firstChild;
  const range = document.createRange();
  if (node && node.nodeType === Node.TEXT_NODE) {
    const len = node.textContent?.length ?? 0;
    range.setStart(node, Math.max(0, Math.min(offset, len)));
  } else {
    range.selectNodeContents(el);
  }
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function getCaretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return 0;
  return sel.getRangeAt(0).startOffset;
}

/** カーソルがel内の装飾を跨いだ本当の先頭(文字数0の位置)にあるかどうか */
function isCaretAtVeryStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return false;
  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length === 0;
}

function focusListItemField(blockId: string, itemId: string, selector: string, offset: number) {
  setTimeout(() => {
    const el = document.querySelector<HTMLElement>(
      `[data-block-id="${blockId}"] [data-item-id="${itemId}"] ${selector}`
    );
    if (el) placeCaretInField(el, offset);
  }, 0);
}

function focusTextBlockAt(blockId: string, offset: number) {
  setTimeout(() => {
    const el = document.querySelector<HTMLElement>(`[data-block-id="${blockId}"] .b-content`);
    if (el) placeCaretInField(el, offset);
  }, 0);
}

/**
 * リスト項目の共通キー操作。
 * Tab/Shift+Tabで階層(level)を1段変更し、ArrowUp/ArrowDownで前後の項目にフォーカス移動し、
 * 行頭でのBackspaceで1つ前の項目に統合(空行ならただ削除)する。
 * 処理した(=呼び出し元でこれ以上何もしなくてよい)場合はtrueを返す。
 */
function handleOutlineKeyDown(
  e: React.KeyboardEvent<HTMLElement>,
  items: { id: string; text: string; level?: number }[],
  itemId: string,
  blockId: string,
  selector: string,
  onLevelChange: () => void
): boolean {
  const idx = items.findIndex((it) => it.id === itemId);
  if (idx === -1) return false;

  if (e.key === "Backspace") {
    const el = e.currentTarget;
    const offset = getCaretOffset(el);
    const sel = window.getSelection();
    if (offset === 0 && (sel?.isCollapsed ?? true)) {
      const currentHtml = el.innerHTML ?? "";
      const isEmpty = (el.textContent ?? "").trim() === "";
      if (idx > 0) {
        e.preventDefault();
        const prev = items[idx - 1];
        // prevがプレーンテキストなら正確な位置に、リッチな内容なら先頭にカーソルを置く
        // (複数ノードにまたがる正確な文字オフセット計算は行わない簡易対応)
        const prevIsPlain = !/<[a-z][\s\S]*>/i.test(prev.text);
        const mergeAt = prevIsPlain ? prev.text.length : 0;
        prev.text = prev.text + currentHtml;
        items.splice(idx, 1);
        onLevelChange();
        focusListItemField(blockId, prev.id, selector, mergeAt);
        return true;
      }
      if (isEmpty && items.length > 1) {
        e.preventDefault();
        items.splice(idx, 1);
        onLevelChange();
        focusListItemField(blockId, items[0].id, selector, 0);
        return true;
      }
    }
    return false;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    const item = items[idx];
    const level = item.level ?? 0;
    if (e.shiftKey) {
      if (level > 0) {
        item.level = level - 1;
        onLevelChange();
      }
    } else {
      const prevLevel = idx > 0 ? items[idx - 1].level ?? 0 : 0;
      if (idx > 0 && level < prevLevel + 1 && level < MAX_LIST_LEVEL) {
        item.level = level + 1;
        onLevelChange();
      }
    }
    const offset = getCaretOffset(e.currentTarget);
    focusListItemField(blockId, itemId, selector, offset);
    return true;
  }

  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const targetIdx = e.key === "ArrowUp" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= items.length) return false;
    e.preventDefault();
    const offset = getCaretOffset(e.currentTarget);
    focusListItemField(blockId, items[targetIdx].id, selector, offset);
    return true;
  }

  return false;
}

/**
 * checklist/bulletlist/numberlist の1項目のテキスト欄。
 * 見出し・本文ブロックと同じく、wikiリンククリック・吹き出しクリック・右クリックの
 * リッチテキストメニュー(太字/文字色/リンク/吹き出し)に対応する。
 */
function OutlineTextField({
  className,
  html,
  editor,
  blockId,
  itemId,
  onInput,
  onKeyDown,
}: {
  className: string;
  html: string;
  editor: EditorProps;
  blockId: string;
  itemId: string;
  onInput: (html: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = syncLinkLabels(html, editor.titles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      contentEditable
      suppressContentEditableWarning
      onInput={(e) => onInput(e.currentTarget.innerHTML)}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const link = target.closest?.("a.wikilink");
        if (link && ref.current) {
          e.preventDefault();
          e.stopPropagation();
          editor.onWikilinkClick(link as HTMLAnchorElement, ref.current, blockId, itemId);
          return;
        }
        const extLink = target.closest?.("a.ext-link") as HTMLAnchorElement | null;
        if (extLink) {
          e.preventDefault();
          e.stopPropagation();
          window.open(extLink.href, "_blank", "noopener,noreferrer");
          return;
        }
        const co = target.closest?.(".callout-inline");
        if (co) {
          e.preventDefault();
          e.stopPropagation();
          editor.onCalloutClick(co as HTMLElement);
        }
      }}
      onContextMenu={(e) => {
        const sel = window.getSelection();
        if (sel?.rangeCount && !sel.isCollapsed && ref.current?.contains(sel.anchorNode)) {
          e.preventDefault();
          editor.onContextSelection(e.clientX, e.clientY, ref.current, blockId, itemId);
        }
      }}
    />
  );
}

function ChecklistView({
  block,
  editor,
}: {
  block: Extract<ClientBlock, { type: "checklist" }>;
  editor: EditorProps;
}) {
  return (
    <div className="block-row b-checklist" data-block-id={block.id}>
      <BlockControls blockId={block.id} onOpenTypeMenu={editor.onOpenTypeMenu} />
      <div className="block-body">
        <div className="items">
          {block.items.map((item) => (
            <div
              key={item.id}
              className={"chk-item" + (item.done ? " done" : "")}
              style={{ marginLeft: (item.level ?? 0) * 22 }}
              data-item-id={item.id}
            >
              <button
                className="chk-circle"
                aria-label={item.done ? "完了を解除" : "完了にする"}
                onClick={(e) => {
                  item.done = !item.done;
                  e.currentTarget.parentElement?.classList.toggle("done", item.done);
                  editor.onSoftChange();
                }}
              >
                ✓
              </button>
              <OutlineTextField
                className="chk-text"
                html={item.text}
                editor={editor}
                blockId={block.id}
                itemId={item.id}
                onInput={(html) => {
                  item.text = html;
                  editor.onSoftChange();
                }}
                onKeyDown={(e) => {
                  if (
                    handleOutlineKeyDown(e, block.items, item.id, block.id, ".chk-text", () =>
                      editor.onStructuralChange()
                    )
                  ) {
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    item.text = e.currentTarget.innerHTML;
                    const idx = block.items.indexOf(item);
                    const ni = { id: uid("i"), text: "", done: false, level: item.level };
                    block.items.splice(idx + 1, 0, ni);
                    editor.onStructuralChange();
                    focusListItemField(block.id, ni.id, ".chk-text", 0);
                  }
                }}
              />
            </div>
          ))}
        </div>
        <div
          className="chk-add"
          onClick={() => {
            const ni = { id: uid("i"), text: "", done: false };
            block.items.push(ni);
            editor.onStructuralChange();
            focusListItemField(block.id, ni.id, ".chk-text", 0);
          }}
        >
          ＋ 項目を追加
        </div>
      </div>
    </div>
  );
}

const BULLET_MARKERS = ["•", "◦", "▪"];

/** 番号付きリストの表示番号を、階層(level)ごとに振り直して計算する */
function computeOutlineMarkers(items: { level?: number }[], ordered: boolean): string[] {
  const counters = [0, 0, 0, 0, 0, 0];
  return items.map((it) => {
    const level = Math.min(Math.max(it.level ?? 0, 0), counters.length - 1);
    if (!ordered) return BULLET_MARKERS[Math.min(level, BULLET_MARKERS.length - 1)];
    counters[level] += 1;
    for (let d = level + 1; d < counters.length; d++) counters[d] = 0;
    return `${counters[level]}.`;
  });
}

function ListView({
  block,
  editor,
}: {
  block: Extract<ClientBlock, { type: "bulletlist" | "numberlist" }>;
  editor: EditorProps;
}) {
  const markers = computeOutlineMarkers(block.items, block.type === "numberlist");
  return (
    <div className={`block-row b-${block.type}`} data-block-id={block.id}>
      <BlockControls blockId={block.id} onOpenTypeMenu={editor.onOpenTypeMenu} />
      <div className="block-body">
        <div className="items">
          {block.items.map((item, idx) => (
            <div
              key={item.id}
              className="list-item"
              style={{ marginLeft: (item.level ?? 0) * 22 }}
              data-item-id={item.id}
            >
              <div className="marker">{markers[idx]}</div>
              <OutlineTextField
                className="list-text"
                html={item.text}
                editor={editor}
                blockId={block.id}
                itemId={item.id}
                onInput={(html) => {
                  item.text = html;
                  editor.onSoftChange();
                }}
                onKeyDown={(e) => {
                  if (
                    handleOutlineKeyDown(e, block.items, item.id, block.id, ".list-text", () =>
                      editor.onStructuralChange()
                    )
                  ) {
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    item.text = e.currentTarget.innerHTML;
                    const i = block.items.indexOf(item);
                    const ni = { id: uid("i"), text: "", level: item.level };
                    block.items.splice(i + 1, 0, ni);
                    editor.onStructuralChange();
                    focusListItemField(block.id, ni.id, ".list-text", 0);
                  }
                }}
              />
            </div>
          ))}
        </div>
        <div
          className="list-add"
          onClick={() => {
            const ni = { id: uid("i"), text: "" };
            block.items.push(ni);
            editor.onStructuralChange();
            focusListItemField(block.id, ni.id, ".list-text", 0);
          }}
        >
          ＋ 項目を追加
        </div>
      </div>
    </div>
  );
}

function TableView({
  block,
  editor,
}: {
  block: Extract<ClientBlock, { type: "table" }>;
  editor: EditorProps;
}) {
  const colCount = block.rows[0]?.length ?? 0;
  return (
    <div className="block-row b-table" data-block-id={block.id}>
      <BlockControls blockId={block.id} onOpenTypeMenu={editor.onOpenTypeMenu} />
      <div className="block-body">
        <div className="table-wrap">
          <table className="note-table">
            <tbody>
              <tr>
                <td className="table-corner" />
                {Array.from({ length: colCount }).map((_, c) => (
                  <td
                    key={c}
                    className="table-col-handle"
                    title="この列を削除"
                    onClick={() => {
                      if (colCount <= 1) return;
                      for (const r of block.rows) r.splice(c, 1);
                      editor.onStructuralChange();
                    }}
                  >
                    {colCount > 1 ? "×" : ""}
                  </td>
                ))}
              </tr>
              {block.rows.map((row, ri) => (
                <tr key={ri} className="data-row">
                  <td
                    className="table-row-handle"
                    title="この行を削除"
                    onClick={() => {
                      if (block.rows.length <= 1) return;
                      block.rows.splice(ri, 1);
                      editor.onStructuralChange();
                    }}
                  >
                    {block.rows.length > 1 ? "×" : ""}
                  </td>
                  {row.map((val, ci) => (
                    <td key={ci} className="cell-td">
                      <div
                        className="table-cell"
                        contentEditable
                        suppressContentEditableWarning
                        ref={(el) => {
                          if (el && el.textContent !== val) el.textContent = val;
                        }}
                        onInput={(e) => {
                          block.rows[ri][ci] = e.currentTarget.textContent ?? "";
                          editor.onSoftChange();
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-toolbar">
          <button
            onClick={() => {
              block.rows.push(Array.from({ length: colCount }, () => ""));
              editor.onStructuralChange();
            }}
          >
            ＋ 行を追加
          </button>
          <button
            onClick={() => {
              for (const r of block.rows) r.push("");
              editor.onStructuralChange();
            }}
          >
            ＋ 列を追加
          </button>
        </div>
      </div>
    </div>
  );
}

function ImageView({
  block,
  editor,
}: {
  block: Extract<ClientBlock, { type: "image" }>;
  editor: EditorProps;
}) {
  return (
    <div className="block-row b-image" data-block-id={block.id}>
      <BlockControls blockId={block.id} onOpenTypeMenu={editor.onOpenTypeMenu} />
      <div className="block-body">
        {block.src ? (
          <div className="img-frame">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={block.src} alt={block.caption || "挿入画像"} />
          </div>
        ) : (
          <div className="img-empty" onClick={() => editor.onImagePick(block.id)}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <span>{block.uploading ? "アップロード中…" : "クリックして画像を追加"}</span>
          </div>
        )}
        <div
          className="caption"
          contentEditable
          suppressContentEditableWarning
          data-placeholder="キャプションを入力(任意)"
          ref={(el) => {
            if (el && el.textContent !== block.caption) el.textContent = block.caption;
          }}
          onInput={(e) => {
            block.caption = e.currentTarget.textContent ?? "";
            editor.onSoftChange();
          }}
        />
      </div>
    </div>
  );
}
