"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type IndexedFile = {
  id: string; name: string; path: string; company: string; extension: string;
  day?: string; month?: string;
  size: number; content: string; pages: string[]; file: File;
};
type SearchResult = IndexedFile & { matchedPages: number[] };

const GUEST_DB_NAME = "nationality-guest-files";
const GUEST_DB_VERSION = 1;
const GUEST_STORE_NAME = "files";
const GUEST_STATE_KEY = "nationality-guest-extractor-state-v1";
async function readBrowserStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  if (typeof estimate.quota !== "number") return null;
  return { usage: estimate.usage ?? 0, quota: estimate.quota };
}

function formatStorageMB(bytes: number) {
  return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + "MB";
}


function openGuestFilesDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(GUEST_DB_NAME, GUEST_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(GUEST_STORE_NAME)) {
        db.createObjectStore(GUEST_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("تعذر فتح قاعدة البيانات المحلية."));
  });
}

async function saveGuestFiles(files: IndexedFile[]): Promise<void> {
  const db = await openGuestFilesDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(GUEST_STORE_NAME, "readwrite");
    const store = transaction.objectStore(GUEST_STORE_NAME);
    store.clear();
    for (const file of files) store.put(file);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("تعذر حفظ الملفات."));
    transaction.onabort = () => reject(transaction.error || new Error("تم إلغاء حفظ الملفات."));
  });
  db.close();
}

async function loadGuestFiles(): Promise<IndexedFile[]> {
  const db = await openGuestFilesDB();
  const files = await new Promise<IndexedFile[]>((resolve, reject) => {
    const transaction = db.transaction(GUEST_STORE_NAME, "readonly");
    const request = transaction.objectStore(GUEST_STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result || []) as IndexedFile[]);
    request.onerror = () => reject(request.error || new Error("تعذر استعادة الملفات."));
  });
  db.close();
  return files.filter((item) => item.file instanceof Blob).map((item) => {
    const storedBlob = item.file as Blob;
    const restoredFile = storedBlob instanceof File
      ? storedBlob
      : new File([storedBlob], item.name, { type: storedBlob.type });
    return { ...item, file: restoredFile } as IndexedFile;
  });
}

async function clearGuestFiles(): Promise<void> {
  const db = await openGuestFilesDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(GUEST_STORE_NAME, "readwrite");
    transaction.objectStore(GUEST_STORE_NAME).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("تعذر حذف الملفات المحفوظة."));
  });
  db.close();
}

const SUPPORTED = new Set(["pdf", "docx", "msg", "txt", "csv", "xml", "html", "htm", "eml", "log"]);
const normalize = (value: string) =>
  value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const MONTH_FOLDER_PATTERN = /^\\d{1,2}[._ -]?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:[._ -].*)?$/i;

function getFolderMetadata(path: string): { company: string; day?: string; month?: string } {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return { company: "غير محددة" };

  const root = parts[0];
  const isMonthFolder = MONTH_FOLDER_PATTERN.test(root);
  const isDayFolder = /^\\d{1,2}$/.test(root);
  const nestedDay = isMonthFolder && /^\\d{1,2}$/.test(parts[1] || "");

  // Daily upload: Day / Company / Booking file
  // Monthly upload: Month / Day / Company / Booking file
  const companyIndex = nestedDay ? 2 : 1;
  const company = parts.length > companyIndex + 1 ? parts[companyIndex] : "غير محددة";

  return {
    company,
    day: nestedDay ? parts[1] : isDayFolder ? root : undefined,
    month: isMonthFolder ? root : undefined,
  };
}

async function extractText(file: File, extension: string): Promise<{ content: string; pages: string[] }> {
  if (["txt", "csv", "xml", "html", "htm", "eml", "log"].includes(extension)) {
    const content = await file.text();
    return { content, pages: [content] };
  }
  const buffer = await file.arrayBuffer();
  if (extension === "docx") {
    const mammoth = await import("mammoth/mammoth.browser");
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return { content: result.value || "", pages: [result.value || ""] };
  }
  if (extension === "msg") {
    const { MsgReader } = await import("@kenjiuno/msgreader-web-ng");
    const message = new MsgReader(buffer);
    const data = message.getFileData();
    const content = [data.subject, data.senderName, data.senderEmail, data.body, data.headers,
      ...(data.recipients || []).map((recipient) => recipient.name)].filter(Boolean).join("\n");
    return { content, pages: [content] };
  }
  if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const text = await page.getTextContent();
      pages.push(text.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return { content: pages.join("\n"), pages };
  }
  return { content: "", pages: [""] };
}

function titleCaseName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/(^|[\s'-])([\p{L}])/gu,
    (_match, separator: string, letter: string) => separator + letter.toLocaleUpperCase());
}

function titleCaseAnexName(value: string) {
  // Anex prints guest names as SURNAME GIVEN-NAME; show them as Given-name Surname.
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return titleCaseName(parts.length > 1 ? [...parts.slice(1), parts[0]].join(" ") : value);
}

function extractPeople(text: string, searchTerm: string) {
  const clean = text.replace(/[\t|]+/g, " ").replace(/\s+/g, " ").trim();

  // SUN International / Hotel2Sejour voucher:
  // Passenger rows follow the "Passenger Informations" table header.
  const sunSectionIndex = clean.search(/passenger\s+informations/i);
  const isSunVoucher = /SUN\s+INTERNATIONAL/i.test(clean)
    && /hotel\s+reservation\s+form\s*-?\s*voucher/i.test(clean)
    && sunSectionIndex >= 0;
  if (isSunVoucher) {
    const passengerSection = clean.slice(sunSectionIndex)
      .split(/\b(?:Agency\s+Note|Hotel\s+Notes|Agency\s+Name)\s*:/i)[0];
    const sunRowPattern = /\b(?:MRS|MR|MS|MISS|MSTR|CHD|INF|ADT|ADULT|CHILD)\s+([A-Z][A-Z\s.'’\-]{1,65}?)\s+(-|\d{1,3})\s+(-|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/gi;
    const sunPeople = Array.from(passengerSection.matchAll(sunRowPattern), (match) => ({
      name: titleCaseName(match[1].trim()),
      dob: match[3] === "-" ? "لم يُعثر عليه" : match[3].replace(/[.-]/g, "/"),
    }));
    if (sunPeople.length) {
      const normalizedSearch = normalize(searchTerm);
      const matchesVoucher = !normalizedSearch
        || /^\d{7,8}$/.test(normalizedSearch.replace(/\s+/g, ""))
        || sunPeople.some((person) => normalize(person.name).includes(normalizedSearch)
          || normalizedSearch.split(/\s+/).every((token) =>
            normalize(person.name).split(/\s+/).some((part) => part.includes(token)),
          ));
      return matchesVoucher ? sunPeople : [];
    }
  }


  // Anex alternative voucher: each guest is printed as a comma-separated line:
  // MRS, SURNAME GIVEN-NAME (Citizenship), DD/MM/YYYY, (Age), Passport: ...
  // Parse complete guest rows so footer dates and other numbers are ignored.
  const anexAlternativeRows = /\b(?:MRS|MR|MS|MISS|MSTR|CHD|INF|ADT|ADULT|CHILD)\s*,?\s*([A-Z][A-Z\s.'’-]{1,65}?)\s*\([^)]+\)\s*,\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s*,\s*\(\d{1,3}\)(?:\s*,\s*Passport\s*:)?/gi;
  // In Anex voucher tables, the Res.No column heading appears only once.
  // Each booking starts with: row number + reservation number + status + check-in date.
  // Keep all guest rows between this marker and the next booking marker together.
  const bookingStarts = Array.from(
    clean.matchAll(/(?:^|\s)(\d{1,2})\s+(\d{7,8})\s+(?:new|changed)\s+\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/gi),
    (match) => ({ index: (match.index ?? 0) + (match[0].length - match[0].trimStart().length), reservationNo: match[2] }),
  );
  const bookingGroups = bookingStarts.map((start, index) => {
    const end = bookingStarts[index + 1]?.index ?? clean.length;
    const bookingText = clean.slice(start.index, end);
    const people = Array.from(bookingText.matchAll(anexAlternativeRows), (match) => ({
      sourceName: match[1].trim(),
      name: titleCaseAnexName(match[1]),
      dob: match[2].replace(/[.-]/g, "/"),
    }));
    return { reservationNo: start.reservationNo, people };
  }).filter((group) => group.people.length > 0);

  const alternativePeople = bookingGroups.length
    ? bookingGroups.flatMap((group) => group.people.map((person) => ({
        ...person,
        reservationNo: group.reservationNo,
      })))
    : Array.from(clean.matchAll(anexAlternativeRows), (match) => ({
        sourceName: match[1].trim(),
        name: titleCaseAnexName(match[1]),
        dob: match[2].replace(/[.-]/g, "/"),
        reservationNo: "",
      }));

  if (alternativePeople.length) {
    const normalizedSearch = normalize(searchTerm);
    if (!normalizedSearch) {
      return alternativePeople.map(({ name, dob }) => ({ name, dob }));
    }

    // A 7- or 8-digit query is treated as an Anex reservation number.
    // Return every guest belonging to that exact reservation only.
    const reservationQuery = normalizedSearch.replace(/\s+/g, "");
    if (/^\d{7,8}$/.test(reservationQuery)) {
      const matchingReservation = bookingGroups.find(
        (group) => group.reservationNo === reservationQuery,
      );
      return matchingReservation
        ? matchingReservation.people.map(({ name, dob }) => ({ name, dob }))
        : [];
    }

    // Find the booking containing the searched guest, then return all guests
    // from that same booking (not guests from adjacent reservations).
    // Match both the original surname-first spelling and the display spelling
    // (Anex commonly prints SURNAME GIVEN-NAME, while the UI reverses the order).
    const matchesGuest = (person: { sourceName: string; name: string; dob: string }) => {
      const source = normalize(person.sourceName || "");
      const display = normalize(person.name);
      const sourceTokens = source.split(/\\s+/).filter(Boolean);
      const queryTokens = normalizedSearch.split(/\\s+/).filter(Boolean);
      return source.includes(normalizedSearch)
        || display.includes(normalizedSearch)
        || (queryTokens.length > 0 && queryTokens.every((token) =>
          sourceTokens.some((part) => part.includes(token)) ||
          display.split(/\\s+/).some((part) => part.includes(token)),
        ));
    };

    const matchingGroups = bookingGroups.filter((group) =>
      group.people.some(matchesGuest),
    );
    if (matchingGroups.length) {
      return matchingGroups.flatMap((group) =>
        group.people.map(({ name, dob }) => ({ name, dob })),
      );
    }

    return alternativePeople
      .filter(matchesGuest)
      .map(({ name, dob }) => ({ name, dob }));
  }

  // Anex primary voucher: table with Clients names, citizenship / Date of born / Age.
  if (/clients\s*names\s*,?\s*citizenship/i.test(clean) && /date\s+of\s+born/i.test(clean)) {
    const anexRows = /\b(?:MRS|MR|MS|MISS|MSTR|CHD|INF|ADT|ADULT|CHILD)\b\s+([A-Z][A-Z\s.'’-]{1,65}?)\s*\([^)]+\)\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s+\d{1,3}(?=\s|$)/gi;
    const people = Array.from(clean.matchAll(anexRows), (match) => ({
      name: titleCaseAnexName(match[1]),
      dob: match[2].replace(/[.-]/g, "/"),
    }));
    if (people.length) return people;
  }

  const datePattern = "(?:\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4}|\\d{4}[\\/-]\\d{1,2}[\\/-]\\d{1,2}|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4})";
  const dates: string[] = [];
  const dateRegex = new RegExp("(?:date\\s*of\\s*birth|birth\\s*date|dob|d\\.o\\.b\\.?|تاريخ\\s*الميلاد)\\s*[:#-]?\\s*(" + datePattern + ")", "gi");
  for (const match of clean.matchAll(dateRegex)) dates.push(match[1]);
  const names: string[] = [];
  const nameRegex = /(?:guest\s*name|passenger\s*name|full\s*name|name\s*of\s*guest|guest|passenger|الاسم|اسم\s*النزيل)\s*[:#-]?\s*([\p{L}][\p{L}\s'.-]{2,60}?)(?=\s+(?:date\s*of\s*birth|birth\s*date|dob|d\.o\.b\.?|passport|nationality|room|تاريخ\s*الميلاد)\b|[,;|]|$)/giu;
  for (const match of clean.matchAll(nameRegex)) {
    const candidate = match[1].trim();
    if (candidate && !names.some((name) => normalize(name) === normalize(candidate))) names.push(candidate);
  }
  if (!names.length && searchTerm.trim()) {
    const escaped = searchTerm.trim().replace(/[.*+?^\x24{}()|[\]\\]/g, "\\$&");
    const found = clean.match(new RegExp(escaped, "i"));
    if (found) names.push(found[0]);
  }
  return names.map((name, index) => ({
    name: titleCaseName(name),
    dob: dates[index] || (dates.length === 1 ? dates[0] : "لم يُعثر عليه"),
  }));
}

export default function GuestNameExtractorPage() {
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [folderName, setFolderName] = useState("");
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const [storageMessage, setStorageMessage] = useState("جارٍ استعادة المجلد المحفوظ...");
  const [browserStorage, setBrowserStorage] = useState<{ usage: number; quota: number } | null>(null);

  async function refreshBrowserStorage() {
    try {
      const estimate = await readBrowserStorageEstimate();
      setBrowserStorage(estimate);
    } catch {
      setBrowserStorage(null);
    }
  }
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    void refreshBrowserStorage();
    async function restoreSession() {
      try {
        const [savedFiles, savedStateText] = await Promise.all([
          loadGuestFiles(),
          Promise.resolve(localStorage.getItem(GUEST_STATE_KEY)),
        ]);
        if (!active) return;
        const savedState = savedStateText ? JSON.parse(savedStateText) : {};
        setFiles(savedFiles);
        void refreshBrowserStorage();
        setFolderName(String(savedState.folderName || (savedFiles[0]?.path.split("/")[0] ?? "")));
        const savedQuery = String(savedState.query || "");
        setQuery(savedQuery);
        const savedPage = Math.max(1, Number(savedState.currentPage) || 1);
        setCurrentPage(savedPage);
        if (savedState.selectedId) {
          const item = savedFiles.find((file) => file.id === savedState.selectedId);
          if (item) {
            const q = normalize(savedQuery);
            const matchedPages = item.pages.reduce<number[]>((acc, page, index) => {
              if (normalize([item.name, item.path, item.company, page].join(" ")).includes(q)) acc.push(index + 1);
              return acc;
            }, []);
            setSelected({ ...item, matchedPages: matchedPages.length ? matchedPages : [1] });
            setCurrentPage(Math.min(savedPage, Math.max(1, item.pages.length)));
          }
        }
        setStorageMessage(savedFiles.length
          ? `تم استعادة ${savedFiles.length.toLocaleString("en-US")} ملف من ذاكرة المتصفح.`
          : "لا يوجد مجلد محفوظ حاليًا. اختر مجلد الحجوزات للبدء.");
      } catch {
        if (active) setStorageMessage("تعذرت استعادة المجلد المحفوظ. قد تكون بيانات الموقع قد مُسحت أو مساحة التخزين غير متاحة.");
      } finally {
        if (active) setRestoreComplete(true);
      }
    }
    void restoreSession();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!restoreComplete) return;
    try {
      localStorage.setItem(GUEST_STATE_KEY, JSON.stringify({
        folderName,
        query,
        selectedId: selected?.id || null,
        currentPage,
      }));
    } catch { /* تجاهل تعذر حفظ حالة العرض */ }
  }, [restoreComplete, folderName, query, selected, currentPage]);

  const previewUrl = useMemo(() => selected ? URL.createObjectURL(selected.file) : "", [selected]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const results = useMemo<SearchResult[]>(() => {
    const q = normalize(query);
    if (!q) return [];
    return files.flatMap((item) => {
      const matchedPages = item.pages.reduce<number[]>((acc, page, index) => {
        if (normalize([item.name, item.path, item.company, page].join(" ")).includes(q)) acc.push(index + 1);
        return acc;
      }, []);
      if (normalize([item.name, item.path, item.company].join(" ")).includes(q) && !matchedPages.length) {
        matchedPages.push(1);
      }
      return matchedPages.length ? [{ ...item, matchedPages }] : [];
    });
  }, [files, query]);

  const companies = useMemo(() => new Set(files.map((file) => file.company).filter((name) => name !== "غير محددة")).size, [files]);
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const pageText = selected?.pages[currentPage - 1] || "";
  const extractedPeople = useMemo(() => extractPeople(pageText, query), [pageText, query]);

  async function scanFolder(selectedFiles: FileList | null) {
    if (!selectedFiles?.length) return;
    const allFiles = Array.from(selectedFiles);
    const root = allFiles[0].webkitRelativePath?.split("/")[0] || "المجلد المحدد";
    const readable = allFiles.filter((file) => SUPPORTED.has(file.name.split(".").pop()?.toLowerCase() || ""));
    setBusy(true); setError(""); setWarnings([]); setFiles([]); setQuery(""); setSelected(null);
    setFolderName(root); setProgress({ done: 0, total: readable.length });
    const indexed: IndexedFile[] = []; const failed: string[] = [];
    for (let index = 0; index < readable.length; index++) {
      const file = readable[index]; const extension = file.name.split(".").pop()?.toLowerCase() || "";
      const path = file.webkitRelativePath || file.name;
      try {
        const extracted = await extractText(file, extension);
        const folderMetadata = getFolderMetadata(path);
        indexed.push({ id: path + "-" + file.lastModified + "-" + index, name: file.name, path,
          ...folderMetadata, extension, size: file.size, content: extracted.content,
          pages: extracted.pages, file });
      } catch { failed.push(path); }
      setProgress({ done: index + 1, total: readable.length });
    }
    try {
      await saveGuestFiles(indexed);
      await refreshBrowserStorage();
      setStorageMessage(`تم حفظ ${indexed.length.toLocaleString("en-US")} ملف محليًا في المتصفح. لن تحتاج إلى اختيار المجلد بعد Refresh.`);
    } catch {
      setStorageMessage("تم فحص الملفات لهذه الجلسة، لكن تعذر حفظها بشكل دائم. قد تكون مساحة التخزين غير كافية.");
    }
    setFiles(indexed); setWarnings(failed); setBusy(false);
    if (!readable.length) setError("لم أجد ملفات مدعومة داخل المجلد. الملفات المدعومة: PDF وWord DOCX وOutlook MSG وTXT وCSV وXML.");
    else if (!indexed.length) setError("تعذرت قراءة الملفات المحددة. تحقق من سلامة الملفات ثم حاول مرة أخرى.");
  }

  function openPreview(item: SearchResult) {
    setSelected(item);
    setCurrentPage(item.matchedPages[0] || 1);
  }

  async function removeSavedFolder() {
    if (!window.confirm("هل تريد حذف نسخة المجلد المحفوظة من هذا المتصفح؟ لن يتم حذف الملفات الأصلية من جهازك.")) return;
    try {
      await clearGuestFiles();
      await refreshBrowserStorage();
      localStorage.removeItem(GUEST_STATE_KEY);
      setFiles([]);
      setQuery("");
      setSelected(null);
      setCurrentPage(1);
      setFolderName("");
      setWarnings([]);
      setStorageMessage("تم حذف المجلد المحفوظ من المتصفح.");
    } catch {
      setStorageMessage("تعذر حذف المجلد المحفوظ. حاول مرة أخرى.");
    }
  }

  function printOriginal() {
    if (!selected) return;
    const url = URL.createObjectURL(selected.file);
    const printWindow = window.open(url, "_blank");
    if (printWindow) {
      const timer = window.setInterval(() => {
        try {
          if (printWindow.document.readyState === "complete") {
            window.clearInterval(timer);
            printWindow.focus();
            printWindow.print();
          }
        } catch { /* Native PDF viewer controls printing when cross-origin access is restricted. */ }
      }, 700);
      window.setTimeout(() => window.clearInterval(timer), 10000);
    }
  }

  const [diagnosticStatus, setDiagnosticStatus] = useState("");

  async function copyPageDiagnostics() {
    if (!selected) return;
    setDiagnosticStatus("جارٍ تجهيز بيانات الصفحة...");
    try {
      let diagnostic: unknown;
      if (selected.extension === "pdf") {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const buffer = await selected.file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
        const page = await pdf.getPage(currentPage);
        const textContent = await page.getTextContent();
        const items = textContent.items.flatMap((item) => {
          if (!("str" in item) || !item.str.trim()) return [];
          const transform = "transform" in item ? item.transform : undefined;
          return [{
            text: item.str,
            x: transform?.[4] ?? null,
            y: transform?.[5] ?? null,
            width: "width" in item ? item.width : null,
            height: "height" in item ? item.height : null,
          }];
        });
        diagnostic = {
          fileName: selected.name,
          company: selected.company,
          page: currentPage,
          pageSize: (() => { const viewport = page.getViewport({ scale: 1 }); return { width: viewport.width, height: viewport.height }; })(),
          extractedText: pageText,
          textItemsWithCoordinates: items,
        };
      } else {
        diagnostic = {
          fileName: selected.name,
          company: selected.company,
          page: currentPage,
          extractedText: pageText,
          note: "هذا الملف ليس PDF؛ لا تتوفر إحداثيات عناصر الصفحة.",
        };
      }
      await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2));
      setDiagnosticStatus("تم نسخ بيانات الصفحة. الصقها هنا في المحادثة بعد مراجعتها.");
    } catch (error) {
      setDiagnosticStatus("تعذر النسخ تلقائياً. تأكد من السماح للمتصفح بالوصول إلى الحافظة، ثم حاول مرة أخرى.");
    }
  }

  function formatSize(bytes: number) {
    return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  return (
    <div className="page" dir="rtl">
      <div
        title="المساحة المستخدمة من حصة التخزين التي يخصصها المتصفح لهذا الموقع"
        aria-label={browserStorage ? `استخدام التخزين: ${formatStorageMB(browserStorage.usage)} من ${formatStorageMB(browserStorage.quota)}` : "تعذر قراءة سعة التخزين"}
        style={{
          position: "fixed", top: 8, left: 10, zIndex: 1000,
          padding: "4px 7px", borderRadius: 6,
          background: "rgba(255,255,255,0.92)", border: "1px solid #d7dee8",
          color: "#526174", fontSize: 10, lineHeight: 1.2,
          direction: "ltr", fontVariantNumeric: "tabular-nums",
          boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
        }}
      >
        {browserStorage
          ? `${formatStorageMB(browserStorage.usage)} / ${formatStorageMB(browserStorage.quota)}`
          : "Storage: N/A"}
      </div>
      <header className="hero">
        <p className="eyebrow">Long Beach Resort · Hotel Tools</p>
        <h1>Guest Name Extractor</h1>
        <p>ابحث داخل ملفات الحجوزات، اعرض المستند الأصلي واطبعه، واستخرج أسماء النزلاء وتواريخ الميلاد من الصفحة المعروضة.</p>
      </header>
      <section className="panel">
        <div className="section-heading">
          <div><h2>1. اختيار مجلد الحجوزات بالكامل</h2>
            <p className="muted">اختر المجلد الرئيسي. تتم قراءة الملفات محلياً داخل المتصفح دون رفعها إلى الخادم.</p></div>
          <button type="button" className="add-button" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? "جارٍ فحص المجلد..." : "اختيار مجلد"}
          </button>
          {files.length > 0 && <button type="button" className="add-button" onClick={() => void removeSavedFolder()} disabled={busy}>حذف المجلد المحفوظ</button>}
          <input ref={inputRef} type="file" multiple hidden
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(event) => { void scanFolder(event.currentTarget.files); event.currentTarget.value = ""; }} />
        </div>
        {folderName && <div className="filename">المجلد: {folderName}</div>}
        <p className="saved-hint" role="status">{storageMessage}</p>
        {busy && <div className="folder-progress" role="status">
          <div className="progress-track"><span style={{ width: progress.total ? (progress.done / progress.total * 100) + "%" : "0%" }} /></div>
          <p className="saved-hint">جارٍ فحص الملفات: {progress.done} من {progress.total}</p>
        </div>}
        {error && <div className="notice error">{error}</div>}
        {warnings.length > 0 && <div className="notice">تعذرت قراءة {warnings.length} ملف، وتم استكمال فحص بقية الملفات.</div>}
      </section>

      {files.length > 0 && <>
        <section className="panel">
          <h2>2. البحث بالاسم أو الشركة أو رقم الحجز</h2>
          <p className="muted">ستظهر الملفات والصفحات المطابقة. يمكنك البحث باسم النزيل أو اسم الشركة أو رقم الحجز. عند البحث برقم الحجز ستظهر بيانات جميع النزلاء المرتبطين به.</p>
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="اكتب اسم النزيل أو اسم الشركة أو رقم الحجز..." aria-label="البحث باسم النزيل أو الشركة أو رقم الحجز"
            style={{ width: "100%", minHeight: 50, border: "1px solid #cbd6e2", borderRadius: 10, padding: "10px 14px", font: "inherit" }} />
          <div className="folder-stats">
            <div><strong>{files.length}</strong><span>ملف تمت قراءته</span></div>
            <div><strong>{companies}</strong><span>شركة/مجلد شركة</span></div>
            <div><strong>{formatSize(totalSize)}</strong><span>إجمالي حجم الملفات</span></div>
          </div>
          {query.trim() && <p className="saved-hint">عدد الصفحات/المستندات المطابقة: {results.length}</p>}
        </section>
        {query.trim() && <section className="panel">
          <h2>3. نتائج البحث</h2>
          {results.length ? <div className="folder-results">{results.map((item) => (
            <article className="folder-result" key={item.id + item.matchedPages.join(",")}>
              <div className="folder-result-top"><div>
                <strong>{item.name}</strong>
                <p className="muted">الشركة: {item.company}{item.month ? ` · الشهر: ${item.month}` : ""}{item.day ? ` · اليوم: ${item.day}` : ""} · النوع: {item.extension.toUpperCase()} · الحجم: {formatSize(item.size)}</p>
                <p className="muted">الصفحات المطابقة: {item.matchedPages.join(", ")}</p>
              </div><button type="button" className="add-button" onClick={() => openPreview(item)}>معاينة واستخراج</button></div>
              <p className="folder-path" dir="ltr">{item.path}</p>
            </article>
          ))}</div> : <p className="empty-exclusions">لا توجد ملفات تحتوي على كلمة البحث.</p>}
        </section>}
      </>}

      {selected && <section className="panel" aria-label="معاينة المستند">
        <div className="section-heading">
          <div><h2>4. معاينة المستند واستخراج البيانات</h2>
            <p className="muted">{selected.name} · {selected.company}</p></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="add-button" onClick={printOriginal}>طباعة الملف</button>
            <button type="button" className="add-button" onClick={() => void copyPageDiagnostics()}>نسخ بيانات الصفحة للتشخيص</button>
            <button type="button" className="add-button" onClick={() => setSelected(null)}>إغلاق المعاينة</button>
          </div>
        </div>
        {selected.extension === "pdf" && <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0" }}>
          <label htmlFor="pdf-page">الصفحة الحالية:</label>
          <select id="pdf-page" value={currentPage} onChange={(event) => setCurrentPage(Number(event.target.value))}
            style={{ minHeight: 38, border: "1px solid #cbd6e2", borderRadius: 8, padding: "4px 10px" }}>
            {selected.pages.map((_page, index) => <option key={index} value={index + 1}>صفحة {index + 1}</option>)}
          </select>
          <span className="muted">من {selected.pages.length}</span>
        </div>}
        <div style={{ border: "1px solid #d7dee8", borderRadius: 10, overflow: "hidden", background: "#f3f5f7" }}>
          {selected.extension === "pdf" ? <iframe title="معاينة ملف PDF" src={previewUrl + "#page=" + currentPage + "&toolbar=1"}
            style={{ width: "100%", height: "75vh", maxHeight: 850, minHeight: 560, border: 0 }} /> :
            <pre style={{ whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 600, padding: 18, direction: "rtl", background: "white" }}>{pageText || "لا يوجد نص قابل للعرض."}</pre>}
        </div>
        <div style={{ marginTop: 18 }}>
          <h3>الأسماء وتواريخ الميلاد في الصفحة الحالية</h3>
          {extractedPeople.length ? <div className="folder-results">{extractedPeople.map((person, index) => (
            <div className="folder-result" key={index} dir="ltr" style={{ textAlign: "left", fontWeight: 700 }}>
              {person.name} - {person.dob}
            </div>
          ))}</div> : <p className="empty-exclusions">لم يتم العثور على اسم وتاريخ ميلاد بصيغة معروفة في نص هذه الصفحة. قد يحتاج المستند إلى مراجعة يدوية أو OCR إذا كان ممسوحاً ضوئياً.</p>}
          <p className="saved-hint">يتم استخراج البيانات من النص الموجود في الصفحة المحددة فقط. راجع النتيجة قبل اعتمادها.</p>
          {diagnosticStatus && <p className="saved-hint" role="status">{diagnosticStatus}</p>}
          <p className="saved-hint">تنبيه: قد تتضمن البيانات المنسوخة أسماء النزلاء وأرقام جوازات السفر؛ راجعها واحذف أي بيانات لا ترغب في مشاركتها قبل إرسالها.</p>
        </div>
      </section>}

      {warnings.length > 0 && <section className="panel"><h2>ملفات تعذرت قراءتها</h2>
        <ul className="steps">{warnings.map((path) => <li key={path} dir="ltr">{path}</li>)}</ul></section>}
      <p className="foot"><a href="/" style={{ color: "#1769aa" }}>العودة إلى أدوات الفندق</a></p>
    </div>
  );
}
