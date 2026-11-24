"use client";

import { useMemo, useRef, useState } from "react";

type IndexedFile = {
  id: string;
  name: string;
  path: string;
  company: string;
  extension: string;
  size: number;
  content: string;
  file: File;
};

const SUPPORTED = new Set(["pdf", "docx", "msg", "txt", "csv", "xml", "html", "htm", "eml", "log"]);
const normalize = (value: string) =>
  value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function getCompany(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 3) return parts[1];
  if (parts.length === 2) return "غير محددة";
  return "غير محددة";
}

async function extractText(file: File, extension: string): Promise<string> {
  if (["txt", "csv", "xml", "html", "htm", "eml", "log"].includes(extension)) {
    return await file.text();
  }

  const buffer = await file.arrayBuffer();

  if (extension === "docx") {
    const mammoth = await import("mammoth/mammoth.browser");
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value || "";
  }

  if (extension === "msg") {
    const { MsgReader } = await import("@kenjiuno/msgreader-web-ng");
    const message = new MsgReader(buffer);
    const data = message.getFileData();
    return [data.subject, data.senderName, data.senderEmail, data.body, data.headers,
      ...(data.recipients || []).map((recipient) => recipient.name)].filter(Boolean).join("\n");
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
    return pages.join("\n");
  }

  return "";
}

export default function GuestNameExtractorPage() {
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [folderName, setFolderName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = normalize(query);
    if (!q) return [];
    return files.filter((item) =>
      normalize([item.name, item.path, item.company, item.content].join(" ")).includes(q)
    );
  }, [files, query]);

  const companies = useMemo(() => new Set(files.map((file) => file.company).filter((name) => name !== "غير محددة")).size, [files]);
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  async function scanFolder(selected: FileList | null) {
    if (!selected?.length) return;
    const allFiles = Array.from(selected);
    const root = allFiles[0].webkitRelativePath?.split("/")[0] || "المجلد المحدد";
    const readable = allFiles.filter((file) => {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      return SUPPORTED.has(ext);
    });

    setBusy(true);
    setError("");
    setWarnings([]);
    setFiles([]);
    setQuery("");
    setFolderName(root);
    setProgress({ done: 0, total: readable.length });

    const indexed: IndexedFile[] = [];
    const failed: string[] = [];

    for (let index = 0; index < readable.length; index++) {
      const file = readable[index];
      const extension = file.name.split(".").pop()?.toLowerCase() || "";
      const path = file.webkitRelativePath || file.name;
      try {
        const content = await extractText(file, extension);
        indexed.push({
          id: path + "-" + file.lastModified + "-" + index,
          name: file.name,
          path,
          company: getCompany(path),
          extension,
          size: file.size,
          content,
          file,
        });
      } catch {
        failed.push(path);
      }
      setProgress({ done: index + 1, total: readable.length });
    }

    setFiles(indexed);
    setWarnings(failed);
    setBusy(false);
    if (!readable.length) {
      setError("لم أجد ملفات مدعومة داخل المجلد. الملفات المدعومة: PDF وWord DOCX وOutlook MSG وTXT وCSV وXML.");
    } else if (!indexed.length) {
      setError("تعذرت قراءة الملفات المحددة. تحقق من سلامة الملفات ثم حاول مرة أخرى.");
    }
  }

  function openOriginal(item: IndexedFile) {
    const url = URL.createObjectURL(item.file);
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.download = item.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function formatSize(bytes: number) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  return (
    <div className="page" dir="rtl">
      <header className="hero">
        <p className="eyebrow">Long Beach Resort · Hotel Tools</p>
        <h1>Guest Name Extractor</h1>
        <p>ابحث عن اسم النزيل أو الشركة داخل جميع ملفات الحجوزات الموجودة في مجلداتك، وافتح المستند الأصلي مباشرة من النتائج.</p>
      </header>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>1. اختيار مجلد الحجوزات بالكامل</h2>
            <p className="muted">اختر المجلد الرئيسي. ستتم قراءة المجلدات الداخلية والملفات الموجودة بها تلقائياً، دون رفعها إلى الخادم.</p>
          </div>
          <button type="button" className="add-button" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? "جارٍ فحص المجلد..." : "اختيار مجلد"}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(event) => {
              void scanFolder(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </div>

        {folderName && <div className="filename">المجلد: {folderName}</div>}
        {busy && (
          <div className="folder-progress" role="status">
            <div className="progress-track"><span style={{ width: progress.total ? (progress.done / progress.total * 100) + "%" : "0%" }} /></div>
            <p className="saved-hint">جارٍ فحص الملفات: {progress.done} من {progress.total}</p>
          </div>
        )}
        {error && <div className="notice error">{error}</div>}
        {warnings.length > 0 && (
          <div className="notice">تعذرت قراءة {warnings.length} ملف، لكن تم استكمال فحص بقية الملفات. يمكنك مراجعة أسماء الملفات المتعذرة أسفل النتائج.</div>
        )}
      </section>

      {files.length > 0 && (
        <>
          <section className="panel">
            <h2>2. البحث بالاسم أو الشركة</h2>
            <p className="muted">اكتب اسم النزيل أو جزءاً منه، أو اسم الشركة. البحث يشمل محتوى المستندات وأسماء الملفات ومسارات المجلدات.</p>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="اكتب اسم النزيل أو اسم الشركة..."
              aria-label="البحث باسم النزيل أو الشركة"
              style={{ width: "100%", minHeight: 50, border: "1px solid #cbd6e2", borderRadius: 10, padding: "10px 14px", font: "inherit" }}
            />
            <div className="folder-stats">
              <div><strong>{files.length}</strong><span>ملف تمت قراءته</span></div>
              <div><strong>{companies}</strong><span>شركة/مجلد شركة</span></div>
              <div><strong>{formatSize(totalSize)}</strong><span>إجمالي حجم الملفات</span></div>
            </div>
            {query.trim() && <p className="saved-hint">عدد الملفات المطابقة: {results.length}</p>}
          </section>

          {query.trim() && (
            <section className="panel">
              <h2>3. نتائج البحث</h2>
              {results.length ? (
                <div className="folder-results">
                  {results.map((item) => (
                    <article className="folder-result" key={item.id}>
                      <div className="folder-result-top">
                        <div>
                          <strong>{item.name}</strong>
                          <p className="muted">الشركة: {item.company} · النوع: {item.extension.toUpperCase()} · الحجم: {formatSize(item.size)}</p>
                        </div>
                        <button type="button" className="add-button" onClick={() => openOriginal(item)}>فتح الملف الأصلي</button>
                      </div>
                      <p className="folder-path" dir="ltr">{item.path}</p>
                    </article>
                  ))}
                </div>
              ) : <p className="empty-exclusions">لا توجد ملفات تحتوي على كلمة البحث.</p>}
            </section>
          )}
        </>
      )}

      {warnings.length > 0 && (
        <section className="panel">
          <h2>ملفات تعذرت قراءتها</h2>
          <ul className="steps">{warnings.map((path) => <li key={path} dir="ltr">{path}</li>)}</ul>
        </section>
      )}

      <p className="foot"><a href="/" style={{ color: "#1769aa" }}>العودة إلى أدوات الفندق</a></p>
    </div>
  );
}
