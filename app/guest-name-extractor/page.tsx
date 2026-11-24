"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type IndexedFile = {
  id: string; name: string; path: string; company: string; extension: string;
  day?: string; month?: string;
  size: number; content: string; pages: string[]; file: File;
};
type SearchResult = IndexedFile & { matchedPages: number[] };
type MsgAttachmentPreview = { name: string; type: string; blob: Blob; url: string; size: number };
type MsgPreviewData = { subject: string; sender: string; senderEmail: string; to: string; cc: string; sent: string; bodyHtml: string; bodyText: string; attachments: MsgAttachmentPreview[] };

type ArrivalRecord = { roomNo: string; name: string; confirmationNo: string; arrivalTime: string };

const ARRIVAL_REPORT_KEY = "nationality-arrival-report-v1";

async function extractArrivalReport(file: File): Promise<ArrivalRecord[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const records: ArrivalRecord[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items: { y: number; x: number; text: string }[] = [];

    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim() || !("transform" in item)) continue;
      items.push({
        y: item.transform[5],
        x: item.transform[4],
        text: item.str.trim(),
      });
    }

    // PMS reports may position cells on slightly different baselines.
    // A wider tolerance keeps Room No. + Name + Company on the same row.
    const grouped: { y: number; items: { x: number; text: string }[] }[] = [];
    for (const item of items) {
      let line = grouped.find((entry) => Math.abs(entry.y - item.y) <= 5);
      if (!line) {
        line = { y: item.y, items: [] };
        grouped.push(line);
      }
      line.items.push({ x: item.x, text: item.text });
    }

    const lines = grouped
      .sort((a, b) => b.y - a.y)
      .map((line) =>
        line.items
          .sort((a, b) => a.x - b.x)
          .map((item) => item.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      );

    const isRoomLine = (line: string) => {
      const match = line.match(/^(\d{3,5})\s+(.+)$/);
      return Boolean(match && match[2].includes(",") && !/^\d{5,9}\b/.test(match[2]));
    };

    for (let index = 0; index < lines.length; index++) {
      const roomLine = lines[index].match(/^(\d{3,5})\s+(.+)$/);
      if (!roomLine || !roomLine[2].includes(",")) continue;

      const rowText = roomLine[2];
      const companyMarker = rowText.search(/\s+T\s*-/i);
      let guestName = companyMarker >= 0 ? rowText.slice(0, companyMarker).trim() : "";
      if (!guestName) {
        const titledName = rowText.match(/^(.+?,\s*(?:Mr|Mrs|Ms|Miss|Mstr|Master)\.?)\b/i);
        if (titledName) guestName = titledName[1].trim();
      }
      if (!guestName) continue;

      let confirmationNo = "";
      let arrivalTime = "";

      // Conf No. and Arr. Time are printed on the following visual row.
      // Search a few lines ahead because PDF text extraction can split cells.
      for (let next = index + 1; next < Math.min(index + 5, lines.length); next++) {
        if (isRoomLine(lines[next])) break;

        if (!confirmationNo) {
          const conf = lines[next].match(/^\s*(\d{5,9})(?=\s|$)/);
          if (conf) confirmationNo = conf[1];
        }
        if (!arrivalTime) {
          const time = lines[next].match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
          if (time) arrivalTime = time[0].padStart(5, "0");
        }
        if (confirmationNo && arrivalTime) break;
      }

      if (confirmationNo && arrivalTime) {
        records.push({
          roomNo: roomLine[1], // Keep leading zeroes, e.g. 0321.
          name: guestName.replace(/\s+/g, " "),
          confirmationNo,
          arrivalTime,
        });
      }
    }
  }

  const unique = new Map<string, ArrivalRecord>();
  for (const record of records) unique.set(record.confirmationNo, record);
  return Array.from(unique.values());
}

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
    const recipientNames = (data.recipients || [])
      .map((recipient) => recipient.name)
      .filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
    const fields = [
      data.subject && `الموضوع: ${data.subject}`,
      data.senderName && `المرسل: ${data.senderName}`,
      data.senderEmail && `البريد الإلكتروني: ${data.senderEmail}`,
      data.clientSubmitTime && `تاريخ الإرسال: ${data.clientSubmitTime}`,
      recipientNames.length ? `المستلمون: ${recipientNames.join(", ")}` : "",
      typeof data.body === "string" ? data.body : "",
      typeof data.headers === "string" ? `\n--- بيانات الرسالة ---\n${data.headers}` : "",
    ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    const content = fields.join("\n\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
    if (!content || !/[\p{L}\p{N}]/u.test(content)) {
      throw new Error("تعذر استخراج نص مقروء من ملف Outlook MSG.");
    }
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
  // Some PDF text extractors omit the voucher/company heading or place it on
  // another page. Identify the passenger table by its own column headings.
  const hasSunPassengerColumns = /surname\s*,?\s*name/i.test(clean)
    && /birthdate/i.test(clean)
    && /\btitle\b/i.test(clean);
  const isSunPassengerTable = sunSectionIndex >= 0 && hasSunPassengerColumns;
  if (isSunPassengerTable) {
    const passengerSection = clean.slice(sunSectionIndex)
      .split(/\b(?:Agency\s+Note|Hotel\s+Notes|Agency\s+Name|Agency)\b/i)[0];
    const sunRowPattern = /\b(?:MRS|MR|MS|MISS|MSTR|CHD|INF|ADT|ADULT|CHILD)\s+([A-Z][A-Z\s.'’\-]{1,65}?)\s+(-|\d{1,3})\s+(-|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?=\s|$)/gi;
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


  // Odeon voucher: numbered tourist rows use SURNAME/GIVEN-NAME,
  // followed by Adult/Child/Infant, title, and date of birth.
  // Keep detection tolerant because PDF text extraction may omit or reorder
  // some column headings while preserving the actual tourist rows.
  const hasOdeonMarkers = /\b(?:voucher\s*no|operator\s+voucher\s+no)\b/i.test(clean)
    && /\btourists\b/i.test(clean);
  if (hasOdeonMarkers) {
    const voucherMatch = clean.match(/\bVoucher\s*No\s*[:#-]?\s*(\d{5,12})\b/i);
    const operatorVoucherMatch = clean.match(/\bOperator\s+Voucher\s*No\s*[:#-]?\s*(\d{5,12})\b/i);
    const touristsStart = clean.search(/\bTourists\b/i);
    const afterTourists = clean.slice(touristsStart + "Tourists".length);
    const flightOffset = afterTourists.search(/\bFlight\b/i);
    const touristsSection = flightOffset >= 0 ? afterTourists.slice(0, flightOffset) : afterTourists;

    // Capture surname and given name separately. Allow optional spaces around
    // the slash and tolerate punctuation/spacing variations in PDF extraction.
    const odeonRowPattern = /(?:^|\s)(\d{1,2})\s+([\p{L}][\p{L}'-]{1,35})\s*\/\s*([\p{L}][\p{L}\s.'’'-]{0,45}?)\s+(Adult|Child|Infant)\s*-\s*(?:Mr|Mrs|Ms|Miss)\.?\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4}|-)(?=\s|$)/giu;
    const odeonPeople = Array.from(touristsSection.matchAll(odeonRowPattern), (match) => {
      const surname = match[2].trim();
      const givenNames = match[3].trim();
      return {
        sourceName: surname + "/" + givenNames,
        name: titleCaseName(givenNames + " " + surname),
        dob: match[5] === "-" ? "لم يُعثر عليه" : match[5].replace(/[.-]/g, "/"),
      };
    });
    if (odeonPeople.length) {
      const normalizedSearch = normalize(searchTerm);
      const reservationQuery = normalizedSearch.replace(/\s+/g, "");
      if (!normalizedSearch) return odeonPeople.map(({ name, dob }) => ({ name, dob }));
      if (/^\d{5,12}$/.test(reservationQuery)) {
        const ids = [voucherMatch && voucherMatch[1], operatorVoucherMatch && operatorVoucherMatch[1]].filter(Boolean);
        return ids.includes(reservationQuery)
          ? odeonPeople.map(({ name, dob }) => ({ name, dob }))
          : [];
      }
      const matchingPeople = odeonPeople.filter((person) => {
        const source = normalize(person.sourceName.replace("/", " "));
        const display = normalize(person.name);
        const tokens = normalizedSearch.split(/\s+/).filter(Boolean);
        return source.includes(normalizedSearch) || display.includes(normalizedSearch)
          || (tokens.length > 0 && tokens.every((token) =>
            source.split(/\s+/).some((part) => part.includes(token))
            || display.split(/\s+/).some((part) => part.includes(token)),
          ));
      });
      return matchingPeople.length
        ? odeonPeople.map(({ name, dob }) => ({ name, dob }))
        : [];
    }
  }

  // Pegas hotel booking voucher: columns Title, Last Name, First Name,
  // Date of birth. Return every guest row on this page, even when the search
  // term matched another page of the same booking.
  const isPegasVoucher = /\blast\s+name\b/i.test(clean)
    && /\bfirst\s+name\b/i.test(clean)
    && /\bdate\s+of\s+birth\b/i.test(clean);
  if (isPegasVoucher) {
    const pegasRowPattern = /\b(MRS|MR|MS|MISS|MSTR|MISTER|MASTER)\s+([\p{L}][\p{L}'’.-]{1,45})\s+([\p{L}][\p{L}'’.-]{1,45}(?:\s+[\p{L}][\p{L}'’.-]{1,45}){0,3})\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/giu;
    const pegasPeople = Array.from(clean.matchAll(pegasRowPattern), (match) => ({
      name: titleCaseName([match[1], match[2], match[3]].join(" ")),
      dob: match[4].replace(/[/-]/g, "."),
    }));
    if (pegasPeople.length) return pegasPeople;
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
  const [msgPreview, setMsgPreview] = useState<MsgPreviewData | null>(null);
  const [msgPreviewError, setMsgPreviewError] = useState("");
  const [activeAttachment, setActiveAttachment] = useState<MsgAttachmentPreview | null>(null);
  useEffect(() => () => { msgPreview?.attachments.forEach((attachment) => URL.revokeObjectURL(attachment.url)); }, [msgPreview]);
  const [currentPage, setCurrentPage] = useState(1);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const [storageMessage, setStorageMessage] = useState("جارٍ استعادة المجلد المحفوظ...");
  const [browserStorage, setBrowserStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [arrivals, setArrivals] = useState<ArrivalRecord[]>([]);
  const [arrivalReportName, setArrivalReportName] = useState("");
  const [arrivalStatus, setArrivalStatus] = useState("");
  const [arrivalBusy, setArrivalBusy] = useState(false);
  const arrivalInputRef = useRef<HTMLInputElement>(null);

  async function refreshBrowserStorage() {
    try {
      // IndexedDB writes/deletes may finish before the browser's quota
      // estimate reflects the new usage. Wait briefly, then read the
      // browser-managed estimate so the counter is less likely to show
      // the previous value immediately after an upload or deletion.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
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
        const [storedFiles, savedStateText] = await Promise.all([
          loadGuestFiles(),
          Promise.resolve(localStorage.getItem(GUEST_STATE_KEY)),
        ]);
        if (!active) return;

        // Re-parse saved Outlook MSG files. Older cached records may contain
        // the raw OLE/binary bytes as text from before MSG parsing was enabled.
        let migratedMsgFiles = false;
        const savedFiles = await Promise.all(storedFiles.map(async (item) => {
          if (item.extension?.toLowerCase() !== "msg") return item;
          try {
            const extracted = await extractText(item.file, "msg");
            migratedMsgFiles = true;
            return { ...item, content: extracted.content, pages: extracted.pages };
          } catch {
            return item;
          }
        }));
        if (migratedMsgFiles) {
          try { await saveGuestFiles(savedFiles); } catch { /* Keep the readable session data even if migration cannot be persisted. */ }
        }
        const savedState = savedStateText ? JSON.parse(savedStateText) : {};
        setFiles(savedFiles);
        const savedArrivals = localStorage.getItem(ARRIVAL_REPORT_KEY);
        if (savedArrivals) {
          const parsed = JSON.parse(savedArrivals) as ArrivalRecord[];
          if (Array.isArray(parsed)) setArrivals(parsed);
          setArrivalStatus(parsed.length ? `تم استعادة ${parsed.length} حجز من تقرير الوصول المحفوظ.` : "");
        }
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
    const matchingArrivalNames = arrivals
      .filter((item) => normalize(item.roomNo) === q || normalize(item.confirmationNo) === q)
      .map((item) => normalize(item.name));
    return files.flatMap((item) => {
      const matchedPages = item.pages.reduce<number[]>((acc, page, index) => {
        const searchable = normalize([item.name, item.path, item.company, page].join(" "));
        if (searchable.includes(q) || matchingArrivalNames.some((name) => name && searchable.includes(name))) {
          acc.push(index + 1);
        }
        return acc;
      }, []);
      if (normalize([item.name, item.path, item.company].join(" ")).includes(q) && !matchedPages.length) {
        matchedPages.push(1);
      }
      return matchedPages.length ? [{ ...item, matchedPages }] : [];
    });
  }, [files, query, arrivals]);

  const arrivalMatches = useMemo(() => {
    const q = normalize(query).replace(/\\s+/g, "");
    if (!q || !arrivals.length) return [];
    return arrivals.filter((item) =>
      normalize(item.roomNo).replace(/\\s+/g, "").includes(q)
      || normalize(item.confirmationNo).replace(/\\s+/g, "").includes(q)
      || normalize(item.name).includes(normalize(query)),
    );
  }, [arrivals, query]);

  const companies = useMemo(() => new Set(files.map((file) => file.company).filter((name) => name !== "غير محددة")).size, [files]);
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const pageText = selected?.pages[currentPage - 1] || "";
  const extractedPeople = useMemo(() => extractPeople(pageText, query), [pageText, query]);

  async function uploadArrivalReport(selectedFiles: FileList | null) {
    const file = selectedFiles?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setArrivalStatus("من فضلك اختر تقرير PDF بصيغة arr.pdf.");
      return;
    }
    setArrivalBusy(true);
    setArrivalStatus("جارٍ قراءة تقرير الوصول محلياً...");
    try {
      const parsed = await extractArrivalReport(file);
      if (!parsed.length) {
        setArrivalStatus("لم يتم العثور على سجلات وصول قابلة للقراءة. تأكد من أن التقرير يحتوي على أعمدة Room No. وName وConf No. وArr. Time.");
        return;
      }
      setArrivals(parsed);
      setArrivalReportName(file.name);
      localStorage.setItem(ARRIVAL_REPORT_KEY, JSON.stringify(parsed));
      setArrivalStatus(`تم استخراج ${parsed.length.toLocaleString("en-US")} حجز من التقرير ${file.name} وحفظ البيانات محلياً.`);
    } catch {
      setArrivalStatus("تعذرت قراءة التقرير. تأكد من سلامة ملف PDF ثم حاول مرة أخرى.");
    } finally {
      setArrivalBusy(false);
    }
  }

  function clearArrivalReport() {
    localStorage.removeItem(ARRIVAL_REPORT_KEY);
    setArrivals([]);
    setArrivalReportName("");
    setArrivalStatus("تم حذف بيانات تقرير الوصول المحفوظة من المتصفح.");
  }

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
    setMsgPreview(null);
    setMsgPreviewError("");
    setActiveAttachment(null);
    if (item.extension.toLowerCase() !== "msg") return;
    void (async () => {
      try {
        const { MsgReader } = await import("@kenjiuno/msgreader-web-ng");
        const reader = new MsgReader(await item.file.arrayBuffer());
        const data = reader.getFileData() as unknown as Record<string, unknown>;
        const recipients = Array.isArray(data.recipients) ? data.recipients as Array<Record<string, unknown>> : [];
        const names = (kind: string) => recipients
          .filter((recipient) => String(recipient.recipType || "to").toLowerCase() === kind)
          .map((recipient) => String(recipient.name || recipient.email || "").trim())
          .filter(Boolean).join("; ");
        const attachmentRows = Array.isArray(data.attachments) ? data.attachments as Array<Record<string, unknown>> : [];
        const msgReader = reader as unknown as {
          getAttachment: (attachment: unknown) => { fileName?: string; content: Uint8Array };
        };
        const attachments: MsgAttachmentPreview[] = attachmentRows.map((row) => {
          const extracted = msgReader.getAttachment(row);
          const name = String(extracted.fileName || row.fileName || row.name || "attachment");
          const extension = name.split(".").pop()?.toLowerCase() || "";
          const mimeByExtension: Record<string, string> = {
            pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            gif: "image/gif", webp: "image/webp", txt: "text/plain", csv: "text/csv",
            html: "text/html", htm: "text/html",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          };
          const mime = String(row.attachMimeTag || mimeByExtension[extension] || "application/octet-stream");
          const blob = new Blob([new Uint8Array(extracted.content).buffer as ArrayBuffer], { type: mime });
          return { name, type: mime, blob, url: URL.createObjectURL(blob), size: blob.size };
        });
        const html = typeof data.bodyHtml === "string" ? data.bodyHtml : "";
        const safeHtml = html
          .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
          .replace(/\s on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
          .replace(/javascript\s*:/gi, "");
        const sentValue = data.messageDeliveryTime || data.clientSubmitTime || data.creationTime || "";
        setMsgPreview({
          subject: String(data.subject || item.name),
          sender: String(data.senderName || data.senderEmail || ""),
          senderEmail: String(data.senderEmail || ""),
          to: names("to") || recipients.map((recipient) => String(recipient.name || "")).filter(Boolean).join("; "),
          cc: names("cc"),
          sent: sentValue ? new Date(String(sentValue)).toLocaleString() : "",
          bodyHtml: safeHtml,
          bodyText: typeof data.body === "string" ? data.body : "",
          attachments,
        });
      } catch (error) {
        setMsgPreviewError(error instanceof Error ? error.message : "تعذرت قراءة مرفقات رسالة Outlook.");
      }
    })();
  }

  function downloadMsgAttachment(attachment: MsgAttachmentPreview) {
    const link = document.createElement("a");
    link.href = attachment.url;
    link.download = attachment.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadOriginalMsg() {
    if (!selected || selected.extension.toLowerCase() !== "msg") return;
    // Download the untouched original MSG file. Outlook on the user's computer
    // can then open and print the authoritative message and its attachments.
    const url = URL.createObjectURL(selected.file);
    const link = document.createElement("a");
    link.href = url;
    link.download = selected.name.toLowerCase().endsWith(".msg") ? selected.name : selected.name + ".msg";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function openOriginalMsgInOutlook() {
    if (!selected || selected.extension.toLowerCase() !== "msg") return;
    // Ask the browser/OS to handle the untouched MSG blob in a new tab.
    // Whether this launches Outlook depends on browser and Windows file associations.
    const outlookBlob = new Blob([selected.file], { type: "application/vnd.ms-outlook" });
    const url = URL.createObjectURL(outlookBlob);
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      URL.revokeObjectURL(url);
      downloadOriginalMsg();
      setStorageMessage("منع المتصفح فتح نافذة جديدة؛ تم بدء تنزيل ملف MSG الأصلي بدلاً من ذلك.");
      return;
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    setStorageMessage("تم إرسال ملف MSG الأصلي إلى المتصفح لمحاولة فتحه. إذا لم يفتح Outlook، استخدم زر تنزيل الملف الأصلي.");
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
          <button type="button" className="add-button" onClick={() => arrivalInputRef.current?.click()} disabled={arrivalBusy}>
            {arrivalBusy ? "جارٍ قراءة التقرير..." : arrivals.length ? "استبدال تقرير arr.pdf" : "رفع تقرير arr.pdf"}
          </button>
          {arrivals.length > 0 && <button type="button" className="add-button" onClick={clearArrivalReport} disabled={arrivalBusy}>حذف تقرير الوصول</button>}
          <input ref={arrivalInputRef} type="file" accept=".pdf,application/pdf" hidden
            onChange={(event) => { void uploadArrivalReport(event.currentTarget.files); event.currentTarget.value = ""; }} />
          <input ref={inputRef} type="file" multiple hidden
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(event) => { void scanFolder(event.currentTarget.files); event.currentTarget.value = ""; }} />
        </div>
        {folderName && <div className="filename">المجلد: {folderName}</div>}
        <p className="saved-hint" role="status">{storageMessage}</p>
        {arrivalReportName && <div className="filename">تقرير الوصول: {arrivalReportName} · {arrivals.length.toLocaleString("en-US")} حجز</div>}
        {arrivalStatus && <p className="saved-hint" role="status">{arrivalStatus}</p>}
        {busy && <div className="folder-progress" role="status">
          <div className="progress-track"><span style={{ width: progress.total ? (progress.done / progress.total * 100) + "%" : "0%" }} /></div>
          <p className="saved-hint">جارٍ فحص الملفات: {progress.done} من {progress.total}</p>
        </div>}
        {error && <div className="notice error">{error}</div>}
        {warnings.length > 0 && <div className="notice">تعذرت قراءة {warnings.length} ملف، وتم استكمال فحص بقية الملفات.</div>}
      </section>

      {files.length > 0 && <>
        <section className="panel">
          <h2>2. البحث بالاسم أو الشركة أو رقم الحجز أو رقم الغرفة أو الرقم التأكيدي</h2>
          <p className="muted">ستظهر الملفات والصفحات المطابقة. عند رفع تقرير arr.pdf يمكنك أيضاً البحث برقم الغرفة أو الرقم التأكيدي لعرض اسم النزيل وميعاد وصوله.</p>
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="اكتب الاسم أو الشركة أو رقم الحجز أو رقم الغرفة أو الرقم التأكيدي..." aria-label="البحث بالاسم أو الشركة أو رقم الحجز أو رقم الغرفة أو الرقم التأكيدي"
            style={{ width: "100%", minHeight: 50, border: "1px solid #cbd6e2", borderRadius: 10, padding: "10px 14px", font: "inherit" }} />
          <div className="folder-stats">
            <div><strong>{files.length}</strong><span>ملف تمت قراءته</span></div>
            <div><strong>{companies}</strong><span>شركة/مجلد شركة</span></div>
            <div><strong>{formatSize(totalSize)}</strong><span>إجمالي حجم الملفات</span></div>
          </div>
          {query.trim() && <p className="saved-hint">عدد الصفحات/المستندات المطابقة: {results.length} · حجوزات تقرير الوصول المطابقة: {arrivalMatches.length}</p>}
          {query.trim() && arrivalMatches.length > 0 && <div className="folder-results" style={{ marginTop: 14 }}>
            {arrivalMatches.map((item) => (
              <article className="folder-result" key={item.confirmationNo}>
                <strong>{item.name}</strong>
                <p className="muted">رقم الغرفة: {item.roomNo} · الرقم التأكيدي: {item.confirmationNo} · موعد الوصول: {item.arrivalTime}</p>
              </article>
            ))}
          </div>}
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
            {selected.extension === "msg" ? <>
              <button type="button" className="add-button" onClick={openOriginalMsgInOutlook}>فتح في Outlook</button>
              <button type="button" className="add-button" onClick={downloadOriginalMsg}>تنزيل الملف الأصلي</button>
            </> : <button type="button" className="add-button" onClick={printOriginal}>طباعة الملف</button>}
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
        {selected.extension === "msg" ? (
          <div style={{ border: "1px solid #c8d2df", borderRadius: 8, overflow: "hidden", background: "#fff", color: "#253247", direction: "ltr", textAlign: "left" }}>
            {msgPreviewError && <div role="alert" style={{ padding: 14, color: "#a12622", background: "#fff1f0" }}>{msgPreviewError}</div>}
            {!msgPreview && !msgPreviewError && <p style={{ padding: 22 }}>جارٍ قراءة رسالة Outlook ومرفقاتها...</p>}
            {msgPreview && <>
              <div style={{ background: "#f2f5f9", borderBottom: "1px solid #d5dce5", padding: "18px 22px" }}>
                <h3 style={{ margin: "0 0 14px", color: "#1d2c42" }}>{msgPreview.subject}</h3>
                {[["From", msgPreview.sender + (msgPreview.senderEmail && msgPreview.senderEmail !== msgPreview.sender ? " <" + msgPreview.senderEmail + ">" : "")], ["To", msgPreview.to], ["Cc", msgPreview.cc], ["Sent", msgPreview.sent]].filter((row) => row[1]).map(([label, value]) => (
                  <div key={label} style={{ display: "flex", gap: 12, padding: "3px 0", fontSize: 13 }}><strong style={{ width: 48, color: "#64748b" }}>{label}:</strong><span>{value}</span></div>
                ))}
              </div>
              {msgPreview.attachments.length > 0 ? <div style={{ padding: "12px 18px", borderBottom: "1px solid #e0e5eb", background: "#fafbfd" }}>
                <strong style={{ display: "block", marginBottom: 9 }}>المرفقات ({msgPreview.attachments.length})</strong>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {msgPreview.attachments.map((attachment, index) => (
                    <div key={index} style={{ border: "1px solid #d6dee8", borderRadius: 7, padding: 9, minWidth: 190, maxWidth: 280, background: "white" }}>
                      <div style={{ fontSize: 12, overflowWrap: "anywhere", marginBottom: 8 }}>📎 {attachment.name}<div style={{ color: "#778399", marginTop: 3 }}>{formatSize(attachment.size)}</div></div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button type="button" className="add-button" onClick={() => setActiveAttachment(attachment)}>فتح / عرض</button>
                        <button type="button" className="add-button" onClick={() => downloadMsgAttachment(attachment)}>تنزيل</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div> : <p style={{ padding: "12px 18px", margin: 0, color: "#64748b" }}>لا تحتوي الرسالة على مرفقات.</p>}
              {activeAttachment && <div style={{ padding: 14, borderBottom: "1px solid #d5dce5", background: "#f4f7fb" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <strong>{activeAttachment.name}</strong>
                  <button type="button" className="add-button" onClick={() => setActiveAttachment(null)}>إغلاق المرفق</button>
                </div>
                {activeAttachment.type.startsWith("image/") ? <img src={activeAttachment.url} alt={activeAttachment.name} style={{ maxWidth: "100%", maxHeight: 560, objectFit: "contain" }} /> :
                  activeAttachment.type === "application/pdf" ? <iframe title={activeAttachment.name} src={activeAttachment.url + "#toolbar=1"} style={{ width: "100%", height: 600, border: 0, background: "white" }} /> :
                  activeAttachment.type.startsWith("text/") ? <iframe title={activeAttachment.name} src={activeAttachment.url} style={{ width: "100%", height: 400, border: 0, background: "white" }} /> :
                  <p>لا تتوفر معاينة داخلية لهذا النوع من الملفات. يمكنك تنزيله وفتحه بالبرنامج المناسب.</p>}
              </div>}
              <div style={{ padding: 22, minHeight: 180, fontFamily: "Arial,sans-serif", fontSize: 14, lineHeight: 1.55, overflowWrap: "anywhere" }}>
                {msgPreview.bodyHtml ? <iframe title="محتوى رسالة Outlook" sandbox="" srcDoc={msgPreview.bodyHtml} style={{ width: "100%", minHeight: 360, border: 0, background: "white" }} /> :
                  <pre style={{ whiteSpace: "pre-wrap", font: "inherit", margin: 0 }}>{msgPreview.bodyText || "لا يوجد محتوى نصي في الرسالة."}</pre>}
              </div>
            </>}
          </div>
        ) : <div style={{ border: "1px solid #d7dee8", borderRadius: 10, overflow: "hidden", background: "#f3f5f7" }}>
          {selected.extension === "pdf" ? <iframe title="معاينة ملف PDF" src={previewUrl + "#page=" + currentPage + "&toolbar=1"}
            style={{ width: "100%", height: "75vh", maxHeight: 850, minHeight: 560, border: 0 }} /> :
            <pre style={{ whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 600, padding: 18, direction: "rtl", background: "white" }}>{pageText || "لا يوجد نص قابل للعرض."}</pre>}
        </div>}
        <div style={{ marginTop: 18 }}>
          <h3>الأسماء وتواريخ الميلاد في الصفحة الحالية</h3>
          {extractedPeople.length ? <div className="folder-results">{extractedPeople.map((person, index) => (
            <div className="folder-result" key={index} dir="ltr" style={{ textAlign: "left", fontWeight: 700 }}>
              {selected.company.toLocaleLowerCase() === "pegas" ? `${person.name} ${person.dob}` : `${person.name} - ${person.dob}`}
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
