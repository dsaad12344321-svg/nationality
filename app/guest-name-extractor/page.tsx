"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type IndexedFile = {
  id: string; name: string; path: string; company: string; extension: string;
  day?: string; month?: string;
  size: number; content: string; pages: string[]; file: File;
};
type SearchResult = IndexedFile & { matchedPages: number[] };
type MsgAttachmentPreview = { name: string; type: string; blob: Blob; url: string; size: number };
type AttachmentSearchMatch = { page: number; excerpt: string };
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

// Arrival reports may use "SURNAME, Mr. GIVEN" while vouchers use
// "MR. SURNAME GIVEN". Match meaningful name parts regardless of order.
const arrivalNameMatchesText = (arrivalName: string, searchableText: string) => {
  const ignored = new Set(["mr", "mrs", "ms", "miss", "mstr", "master"]);
  const tokens = normalize(arrivalName).split(/\s+/).filter((token) => token.length > 1 && !ignored.has(token));
  const searchable = ` ${normalize(searchableText)} `;
  return tokens.length >= 2 && tokens.every((token) => searchable.includes(` ${token} `));
};

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
    const attachmentRows = Array.isArray(data.attachments) ? data.attachments as unknown as Array<Record<string, unknown>> : [];
    const attachmentNames = attachmentRows.map((attachment) => String(attachment.fileName || attachment.name || "").trim()).filter(Boolean);
    const fields = [
      data.subject && `الموضوع: ${data.subject}`,
      data.senderName && `المرسل: ${data.senderName}`,
      data.senderEmail && `البريد الإلكتروني: ${data.senderEmail}`,
      data.clientSubmitTime && `تاريخ الإرسال: ${data.clientSubmitTime}`,
      recipientNames.length ? `المستلمون: ${recipientNames.join(", ")}` : "",
      attachmentNames.length ? `المرفقات: ${attachmentNames.join(", ")}` : "",
      typeof data.body === "string" ? data.body : "",
      typeof data.headers === "string" ? `\n--- بيانات الرسالة ---\n${data.headers}` : "",
    ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    const content = fields.join("\n\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
    if (!content || !/[\p{L}\p{N}]/u.test(content)) {
      throw new Error("تعذر استخراج نص مقروء من ملف Outlook MSG.");
    }
    // Index readable PDF attachments as additional searchable pages of the MSG.
    // This makes guest names inside Outlook booking vouchers searchable from
    // the main folder search, not only from the attachment preview.
    const msgReader = message as unknown as {
      getAttachment: (attachment: unknown) => { fileName?: string; content: Uint8Array };
    };
    const attachmentPages: string[] = [];
    for (const attachment of attachmentRows) {
      const attachmentName = String(attachment.fileName || attachment.name || "").trim();
      if (!attachmentName.toLowerCase().endsWith(".pdf")) continue;
      try {
        const extractedAttachment = msgReader.getAttachment(attachment);
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({
          data: new Uint8Array(extractedAttachment.content),
        }).promise;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const pageContent = await page.getTextContent();
          attachmentPages.push(pageContent.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" "));
        }
      } catch {
        // Keep the MSG searchable even if one attachment cannot be parsed.
      }
    }
    return { content: [content, ...attachmentPages].join("\n"), pages: [content, ...attachmentPages] };
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

function expandEagleDob(value: string) {
  const parts = value.trim().split(/[./-]/);
  if (parts.length !== 3) return value;
  const [day, month, rawYear] = parts;
  const year = rawYear.length === 4
    ? rawYear
    : String(Number(rawYear) <= 29 ? 2000 + Number(rawYear) : 1900 + Number(rawYear));
  return day.padStart(2, "0") + "." + month.padStart(2, "0") + "." + year;
}

function extractEaglePeople(text: string) {
  // Eagle Travel Outlook rooming lists use a Names/Age table. Outlook's
  // text extraction commonly places the guest-name column and DOB column
  // in separate runs, so collect both columns in order and pair by index.
  const header = /\bNames\b[\s\S]{0,100}\bAge\b[\s\S]{0,50}\bACC\b/i.exec(text);
  if (!header || header.index === undefined) return [];
  const start = header.index + header[0].indexOf("Names") + "Names".length;
  const tail = text.slice(start);
  // The actual Eagle table ends before the commercial breakdown. Some
  // emails say "Waiting for your reply with confirmation", not the shorter
  // phrase used in older samples, so prefer the table's own boundary.
  const endMatch = /\b(?:Breakdown|Waiting\s+for\s+your\s+(?:reply\s+with\s+)?confirmation|Best\s+regards|From)\b/i.exec(tail);
  const table = endMatch ? tail.slice(0, endMatch.index) : tail.slice(0, 18000);

  const namePattern = /\b(?:Mr|Mrs|Ms|Miss)\.?\s+([\p{L}][\p{L}'’.-]{0,45})\s*\/\s*([\p{L}][\p{L}'’.-]*)/giu;
  const names = Array.from(table.matchAll(namePattern), (match) =>
    titleCaseName(match[1].trim() + " " + match[2].trim()),
  );
  // Dates are emitted in the same guest order as the Names column, although
  // Outlook may place them after the names within each rooming-list row.
  const dates = Array.from(table.matchAll(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/g),
    (match) => expandEagleDob(match[1]));

  if (!names.length || names.length !== dates.length) return [];
  return names.map((name, index) => ({ name, dob: dates[index] }));
}

function extractPeople(text: string, searchTerm: string, company = "") {
  // Eagle Travel rooming lists are sent as Outlook email tables with surname/given-name
  // entries in the Names column and matching two-digit DOBs in the Age column.
  const hasEagleRoomingTable = /\bNames\b[\s\S]{0,200}\bAge\b[\s\S]{0,100}\bACC\b/i.test(text);
  if (hasEagleRoomingTable
    || /^eagle(?:\s*travel)?$/i.test(company.trim())
    || /(?:eagletvl\.com|Eagle\s+Travel)/i.test(text)) {
    const eaglePeople = extractEaglePeople(text);
    if (eaglePeople.length) return eaglePeople;
  }

  // AllTours hotel reservation forms store each guest in a titled table row:
  // "Mr SURNAME, GIVEN NAMES AGE". MSG attachments are indexed as extra pages,
  // so this same parser works for both standalone PDFs and Outlook attachments.
  if (/\balltours?\b/i.test(company.trim())
    || (/\bHOTEL\s+RESERVATION\s+FORM\b/i.test(text)
      && /\bSURNAME,\s*NAME\b/i.test(text)
      && /\bVOUCHER\s+NR\b/i.test(text))) {
    // The MSG may contain several independent AllTours vouchers, one per
    // PDF page. Keep each page as its own booking group and only return the
    // group whose voucher number or guest name matches the current search.
    const pageBreak = "\\n\\n--- ALLTOUR PAGE BREAK ---\\n\\n";
    const bookingPages = text.split(pageBreak).filter((page) => page.trim());
    const normalizedQuery = normalize(searchTerm);
    const matchingPages = normalizedQuery
      ? bookingPages.filter((page) => normalize(page).includes(normalizedQuery))
      : bookingPages;
    const alltourRowPattern = /\b(?:MR|MRS|MS|MISS|MSTR|MASTER)\.?\s+([\p{L}][\p{L}’', .-]{1,80}?)(?=\s+\d{1,3}\s|\s+Revise\s+Description\b|\s+NOTE:|\s+TOTAL\s+PAX\b|$)/giu;
    const alltourPeople = matchingPages.flatMap((page) =>
      Array.from(page.matchAll(alltourRowPattern), (match) => ({
        name: titleCaseName(match[1].trim()),
        dob: "",
      })).filter((person) => person.name.includes(",")),
    );
    if (alltourPeople.length) return alltourPeople;
  }

  // Biblio Globus reservation emails list each guest name followed by DOB.
  // A single MSG may contain many bookings (rooming lists), so isolate every
  // Ref# block first and only parse the block matching the searched reference.
  const isBiblioBooking = /^(?:biblio|biblo)(?:\s*globus(?:\s*egypt)?)?$/i.test(company.trim())
    || (/(?:Biblio|Biblo)\s+Globus/i.test(text)
      && /\bRef\s*#/i.test(text)
      && /\bDate\s+of\s+birth\b/i.test(text)
      && /\bNames\b/i.test(text));
  if (isBiblioBooking) {
    const refMatches = Array.from(text.matchAll(/\bRef\s*#/gi));
    const bookingBlocks = refMatches.map((match, index) => {
      const blockStart = match.index ?? 0;
      const blockEnd = refMatches[index + 1]?.index ?? text.length;
      const block = text.slice(blockStart, blockEnd);
      // The reference may follow a Hotel heading, or Flight Number/Arrival
      // Time fields in a final rooming list. Read it from the whole block.
      const reference = block.match(/\b\d{6,}(?:-\d+)?\b/)?.[0] || "";
      return { block, reference };
    }).filter((item) => item.reference);

    const normalizedSearch = normalize(searchTerm);
    const queryAsReference = normalizedSearch.replace(/[^a-z0-9]/gi, "");
    const matchingBlocks = normalizedSearch
      ? bookingBlocks.filter(({ block, reference }) => {
          const normalizedReference = reference.replace(/[^a-z0-9]/gi, "");
          return (normalizedReference && queryAsReference === normalizedReference)
            || normalize(block).includes(normalizedSearch);
        })
      : bookingBlocks;

    const biblioRowPattern = /([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,5}\s*\/\s*(?:MR|MRS|MS|MISS|CHLD|CHD|INF|MSTR))\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/giu;
    const biblioPeople = matchingBlocks.flatMap(({ block }) => {
      // Names and DOBs are sequential rows after their respective headings.
      // Bound extraction to this booking block to avoid leaking guests from
      // the next reservation in a multi-booking rooming-list email.
      const section = block.match(/\bNames\b[\s\S]*?\bDate\s+of\s+birth\b([\s\S]*?)(?=\bIn\s+respect\s+of\s+our\s+guests\b|\bThanks\s+and\s+Best\s+regards\b|$)/i)?.[1] || "";
      return Array.from(section.matchAll(biblioRowPattern), (match) => {
        const rawName = match[1].trim();
        const nameAndTitle = rawName.match(/^([\s\S]+?)\s*\/\s*(MR|MRS|MS|MISS|CHLD|CHD|INF|MSTR)$/i);
        const displayName = nameAndTitle
          ? titleCaseName(nameAndTitle[1]) + " /" + nameAndTitle[2][0].toUpperCase() + nameAndTitle[2].slice(1).toLowerCase()
          : titleCaseName(rawName);
        return { name: displayName, dob: match[2].replace(/[/-]/g, ".") };
      });
    });
    if (biblioPeople.length) return biblioPeople;
  }

  // EasyJet bookings arrive as Outlook MSG files. Guest names are in the
  // email body under "Names: Age"; the attached PDF is not the source.
  if (/^easy\s*jet$/i.test(company.trim())) {
    const body = text.replace(/[\t|]+/g, " ").replace(/\s+/g, " ").trim();
    const namesSection = body.match(/\bNames\s*:\s*Age\s+([\s\S]*?)(?=\bRoom\s+Taken\s+from\s+Allocation\b|\bFlight\s+Arrival\s+Details\b|\bVoucher\s+attached\b|\bBooking\s+date\b|$)/i)?.[1] || "";
    // Find each title first, then take the text up to the next titled guest.
    // This avoids losing later guests when Outlook flattens line breaks.
    const titlePattern = /\b(?:Mrs|Mr|Ms|Miss|Master)\.?\s+/giu;
    const titleMatches = Array.from(namesSection.matchAll(titlePattern));
    return titleMatches.map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = titleMatches[index + 1]?.index ?? namesSection.length;
      const name = namesSection.slice(start, end)
        .replace(/\s+/g, " ")
        .replace(/[^\p{L}\p{M}'’.-]+$/gu, "")
        .trim();
      return { name: titleCaseName(name), dob: "" };
    }).filter((person) =>
      person.name
      && /^[\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+){1,4}$/u.test(person.name),
    );
  }

  const clean = text.replace(/[\t|]+/g, " ").replace(/\s+/g, " ").trim();

  // Red Sea Tours Outlook bookings: each booking block contains guest names
  // written in French style, e.g. "MR BOUGAULT DOMINIQUE 69 ans".
  // Keep each repeated booking reference as a separate group so a name search
  // returns all guests belonging to that booking, not guests from other rooms.
  if (/^red\s*sea(?:\s*tours)?$/i.test(company.trim())
    || /redseatours-eg\.com/i.test(text)) {
    const bookingChunks = text.split(/(?:^|\r?\n)\s*\d{5,10}\s*(?=\r?\n)/);
    const redSeaGroups = bookingChunks.map((chunk) => {
      const rowPattern = /\b(?:MR|MM|MRS|MS)\.?\s+([\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*){1,5})\s+\d{1,3}\s+ans\b/giu;
      return Array.from(chunk.matchAll(rowPattern), (match) => ({
        name: titleCaseName(match[1].trim()),
        dob: "",
      }));
    }).filter((group) => group.length > 0);
    if (redSeaGroups.length) {
      const normalizedSearch = normalize(searchTerm);
      const matchingGroup = redSeaGroups.find((group) => !normalizedSearch || group.some((person) => {
        const nameParts = normalize(person.name).split(/\s+/);
        const queryParts = normalizedSearch.split(/\s+/).filter(Boolean);
        return queryParts.length > 0 && queryParts.every((token) =>
          nameParts.some((part) => part.includes(token)),
        );
      }));
      return matchingGroup || [];
    }
  }

  // W2M booking emails: guest rows appear in the "Passengers" section as
  // "* Full Name (Age: NN)". Use the full passenger list so every guest is
  // returned, including middle names and repeated surname tokens.
  const isW2mBooking = /^w2m$/i.test(company.trim())
    || (/\bBooking\s+Code\b/i.test(clean)
      && /\bPassenger\s+Name\b/i.test(clean)
      && /\bPassenger\s+Last\s+Name\b/i.test(clean)
      && /\bWorld\s+2\s+Meet\b/i.test(clean));
  if (isW2mBooking) {
    const passengersStart = clean.search(/\bPassengers\s*:/i);
    const passengersEndMatch = passengersStart >= 0
      ? clean.slice(passengersStart).match(/\bNumber\s+of\s+Adults\s*\/\s*Childs\s*\/\s*Babies\b/i)
      : null;
    const passengersSection = passengersStart >= 0
      ? clean.slice(passengersStart + "Passengers:".length,
          passengersEndMatch
            ? passengersStart + "Passengers:".length + passengersEndMatch.index!
            : clean.length)
      : "";
    const w2mRowPattern = /(?:^|\s)\*\s*([\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*){1,7})\s*\(\s*Age\s*:\s*\d{1,3}\s*\)/giu;
    const w2mPeople = Array.from(passengersSection.matchAll(w2mRowPattern), (match) => ({
      name: titleCaseName(match[1].trim()),
      dob: "",
    }));
    if (w2mPeople.length) {
      const normalizedSearch = normalize(searchTerm);
      const matchesBooking = !normalizedSearch || w2mPeople.some((person) => {
        const nameParts = normalize(person.name).split(/\s+/);
        const queryParts = normalizedSearch.split(/\s+/).filter(Boolean);
        return normalizedSearch === normalize(person.name)
          || (queryParts.length > 0 && queryParts.every((token) =>
            nameParts.some((part) => part.includes(token)),
          ));
      });
      return matchesBooking ? w2mPeople : [];
    }
  }

  // TUI Destimo voucher: the PDF text extractor may emit the room columns
  // before the guest rows, even though the visual table places names under
  // the Name header. Therefore scan the remainder of the page, not the text
  // between the Name and Room headers.
  const isTuiVoucher = /\bTUI\s+Ref\s*:/i.test(clean)
    && /\bSuper\s+PNR\s*:/i.test(clean)
    && /\bRoom\s+types\s*\//i.test(clean)
    && /\bName\s+Age\s+Arrival\s+Departure\b/i.test(clean);
  if (isTuiVoucher) {
    const nameHeader = clean.search(/\bName\s+Age\s+Arrival\s+Departure\b/i);
    const guestSection = nameHeader >= 0
      ? clean.slice(nameHeader + "Name Age Arrival Departure".length)
      : "";
    const tuiRowPattern = /([\p{L}\p{M}][\p{L}\p{M}'’.-]{1,50})\s*\/\s*([\p{L}\p{M}][\p{L}\p{M}'’ .-]{0,60}?)\s*\(([FM])\)/gu;
    const tuiPeople = Array.from(guestSection.matchAll(tuiRowPattern), (match) => ({
      name: titleCaseName(`${match[1].trim()} ${match[2].trim()}`),
      dob: "",
    })).filter((person) => person.name);
    if (tuiPeople.length) {
      const normalizedSearch = normalize(searchTerm);
      const matchesVoucher = !normalizedSearch || tuiPeople.some((person) => {
        const name = normalize(person.name);
        return name.includes(normalizedSearch)
          || normalizedSearch.split(/\s+/).filter(Boolean).every((token) =>
            name.split(/\s+/).some((part) => part.includes(token)),
          );
      });
      return matchesVoucher ? tuiPeople : [];
    }
  }

  // tez-tour reservation sheet:
  // Guest rows are printed as Title, Surname, Given name(s), Date of birth.
  // Parse only titled rows with a complete DOB so column headings such as
  // "Guest Information" and "Checkin Date" can never be mistaken for guests.
  const isTezVoucher = /^tez$/i.test(company.trim())
    || (/\bNEW\s+RESERVATION\b/i.test(clean)
      && /\bVoucher\s+No\b/i.test(clean)
      && /\bGuest\s+Information\b/i.test(clean)
      && /\bCheckin\s+Date\b/i.test(clean)
      && /\bCheckout\s+Date\b/i.test(clean));
  if (isTezVoucher) {
    const tezRowPattern = /\b(?:MR|MRS|MS|MISS|MSTR|MASTER)\.?\s+([A-Z][A-Z'’.-]{1,40})\s+([A-Z][A-Z'’.-]*(?:\s+[A-Z][A-Z'’.-]*){0,2})\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/g;
    const tezPeople = Array.from(clean.matchAll(tezRowPattern), (match) => ({
      name: titleCaseName(match[1] + " " + match[2]),
      dob: match[3].replace(/[/-]/g, "."),
    }));
    if (tezPeople.length) return tezPeople;
  }

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
    const sunRowPattern = /\b(?:MRS|MR|MS|MISS|MSTR|CHD|INF|ADT|ADULT|CHILD)\s+([A-Z][A-Z\s,.'’\-]{1,65}?)\s+(-|\d{1,3})\s+(-|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?=\s|$)/gi;
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
  const [attachmentSearchQuery, setAttachmentSearchQuery] = useState("");
  const [attachmentSearchMatches, setAttachmentSearchMatches] = useState<AttachmentSearchMatch[]>([]);
  const [attachmentSearchStatus, setAttachmentSearchStatus] = useState("");
  const [activeAttachmentPage, setActiveAttachmentPage] = useState(1);
  const [attachmentPdfSearchTerm, setAttachmentPdfSearchTerm] = useState("");
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

    // Resolve room/confirmation numbers through arr.pdf, then search by guest name.
    const linkedArrivalGuests = arrivals.filter((item) =>
      normalize(item.roomNo).replace(/\s+/g, "") === q.replace(/\s+/g, "")
      || normalize(item.confirmationNo).replace(/\s+/g, "") === q.replace(/\s+/g, "")
    );
    const isArrivalNumberSearch = linkedArrivalGuests.length > 0;
    const matchingArrivalNames = linkedArrivalGuests.map((item) => item.name);

    return files.flatMap((item) => {
      const matchedPages = item.pages.reduce<number[]>((acc, page, index) => {
        const searchable = [item.name, item.path, item.company, page].join(" ");
        const matchesLinkedGuest = matchingArrivalNames.some((name) => arrivalNameMatchesText(name, searchable));
        const matchesDirectQuery = !isArrivalNumberSearch && normalize(searchable).includes(q);
        if (matchesDirectQuery || matchesLinkedGuest) {
          acc.push(index + 1);
        }
        return acc;
      }, []);
      if (!isArrivalNumberSearch && normalize([item.name, item.path, item.company].join(" ")).includes(q) && !matchedPages.length) {
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
  // MSG files are email messages, not paginated documents. Always parse their
  // primary email body (pages[0]); currentPage may retain a page number from a
  // previously opened PDF or point to an indexed PDF attachment.
  const pageText = selected
    ? selected.extension.toLowerCase() === "msg"
      ? selected.pages[0] || ""
      : selected.pages[currentPage - 1] || ""
    : "";
  // AllTours booking references can be found on a different page from the
  // guest table. Parse the complete MSG/PDF page set for this company so a
  // search by voucher number still displays every guest in that booking.
  const eagleTablePage = selected?.extension.toLowerCase() === "msg"
    ? selected.pages.find((page) => /\bNames\b[\s\S]{0,200}\bAge\b[\s\S]{0,100}\bACC\b/i.test(page))
    : undefined;
  const peopleSourceText = selected && (
    /alltour/i.test(selected.company)
    || selected.pages.some((page) =>
      /HOTEL\s+RESERVATION\s+FORM/i.test(page)
      && /SURNAME,\s*NAME/i.test(page)
      && /VOUCHER\s+NR/i.test(page),
    )
  ) ? selected.pages.join("\n\n--- ALLTOUR PAGE BREAK ---\n\n")
    : eagleTablePage || pageText;
  const extractedPeople = useMemo(
    () => extractPeople(peopleSourceText, query, selected?.company || ""),
    [peopleSourceText, query, selected?.company],
  );

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
          // Outlook/MSG قد يضع application/octet-stream حتى لو كان الامتداد صورة.
          // نثق بنوع MIME الصريح إذا كان مفيدًا، وإلا نستنتجه من امتداد الملف.
          const declaredMime = String(row.attachMimeTag || "").split(";")[0].trim().toLowerCase();
          const mime = declaredMime && declaredMime !== "application/octet-stream"
            ? declaredMime
            : (mimeByExtension[extension] || declaredMime || "application/octet-stream");
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

  async function searchInsideAttachment() {
    if (!activeAttachment) return;
    const term = attachmentSearchQuery.trim();
    if (!term) {
      setAttachmentSearchStatus("اكتب الاسم أو رقم الحجز أولاً.");
      setAttachmentSearchMatches([]);
      return;
    }
    setAttachmentSearchStatus("جارٍ البحث داخل المرفق...");
    setAttachmentSearchMatches([]);
    try {
      const extension = activeAttachment.name.split(".").pop()?.toLowerCase() || "";
      let pages: string[] = [];
      if (extension === "pdf" || activeAttachment.type === "application/pdf") {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await activeAttachment.blob.arrayBuffer()) }).promise;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
        }
      } else if (extension === "docx") {
        const mammoth = await import("mammoth/mammoth.browser");
        const result = await mammoth.extractRawText({ arrayBuffer: await activeAttachment.blob.arrayBuffer() });
        pages = [result.value || ""];
      } else if (["txt", "csv", "xml", "html", "htm", "eml", "log"].includes(extension)) {
        pages = [(await activeAttachment.blob.text())];
      } else if (extension === "msg") {
        const attachmentFile = new File([activeAttachment.blob], activeAttachment.name, { type: activeAttachment.type });
        const extracted = await extractText(attachmentFile, "msg");
        pages = extracted.pages;
      } else {
        setAttachmentSearchStatus("البحث النصي غير متاح لهذا النوع من المرفقات. إذا كان الملف صورة أو PDF ممسوحاً ضوئياً، فهو يحتاج إلى OCR.");
        return;
      }
      const normalizedTerm = normalize(term);
      const matches = pages.flatMap((pageText, index) => {
        const normalizedPage = normalize(pageText);
        if (!normalizedPage.includes(normalizedTerm)) return [];
        const rawPosition = pageText.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
        const excerptStart = rawPosition >= 0 ? Math.max(0, rawPosition - 90) : 0;
        const excerpt = pageText.slice(excerptStart, rawPosition >= 0 ? rawPosition + term.length + 120 : 240).replace(/\s+/g, " ").trim();
        return [{ page: index + 1, excerpt: excerpt || "تم العثور على تطابق في هذه الصفحة." }];
      });
      setAttachmentSearchMatches(matches);
      if (matches.length) {
        setAttachmentPdfSearchTerm(extension === "pdf" || activeAttachment.type === "application/pdf" ? term : "");
        setActiveAttachmentPage(matches[0].page);
        setAttachmentSearchStatus(`تم العثور على ${matches.length} صفحة مطابقة. تم تمرير عبارة البحث إلى عارض PDF لمحاولة تمييزها، مع تكبير العرض.`);
      } else {
        setAttachmentSearchStatus("لم يتم العثور على الاسم أو رقم الحجز داخل نص المرفق. إذا كان المستند ممسوحاً ضوئياً فقد يحتاج إلى OCR.");
      }
    } catch (error) {
      setAttachmentSearchStatus(error instanceof Error ? "تعذر البحث داخل المرفق: " + error.message : "تعذر قراءة المرفق للبحث داخله.");
    }
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

  function printMsgImage(attachment: MsgAttachmentPreview) {
    if (!attachment.type.startsWith("image/")) return;

    // Open a dedicated print page for the selected Outlook image attachment.
    // The popup is created directly from the button click to avoid blockers.
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      window.alert("يرجى السماح بالنوافذ المنبثقة حتى تتمكن من طباعة الصورة.");
      return;
    }

    const safeName = attachment.name.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character] || character);
    printWindow.document.open();
    printWindow.document.write(`<!doctype html>
      <html lang="ar">
        <head>
          <meta charset="utf-8">
          <title>${safeName}</title>
          <style>
            @page { margin: 10mm; }
            html, body { margin: 0; padding: 0; background: #fff; }
            body { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
            img { display: block; max-width: 100%; max-height: 96vh; object-fit: contain; }
            @media print { img { max-height: 275mm; } }
          </style>
        </head>
        <body>
          <img src="${attachment.url}" alt="${safeName}">
          <script>
            const image = document.querySelector("img");
            image.addEventListener("load", () => {
              window.focus();
              window.print();
            }, { once: true });
            image.addEventListener("error", () => {
              document.body.textContent = "تعذر تحميل الصورة للطباعة.";
            }, { once: true });
          </script>
        </body>
      </html>`);
    printWindow.document.close();
  }

  function printVoucher() {
    if (!selected) return;
    // Outlook MSG bookings: print the PDF voucher attached to the email,
    // never the email body. Direct PDF bookings: print the selected PDF itself.
    const voucher = selected.extension === "msg"
      ? msgPreview?.attachments.find((attachment) =>
          attachment.type === "application/pdf" || attachment.name.toLowerCase().endsWith(".pdf"))
      : selected.extension === "pdf"
        ? { blob: selected.file }
        : undefined;

    if (!voucher) {
      window.alert(selected.extension === "msg"
        ? "لا يوجد ملف PDF مرفق بهذه الرسالة. لا يمكن طباعة الفاوتشر."
        : "الطباعة متاحة لملفات PDF فقط.");
      return;
    }

    const url = URL.createObjectURL(voucher.blob);
    const printWindow = window.open(url, "_blank");
    if (!printWindow) {
      URL.revokeObjectURL(url);
      window.alert("يرجى السماح بالنوافذ المنبثقة حتى تتمكن من طباعة الفاوتشر.");
      return;
    }
    const timer = window.setInterval(() => {
      try {
        if (printWindow.document.readyState === "complete") {
          window.clearInterval(timer);
          printWindow.focus();
          printWindow.print();
        }
      } catch {
        // The browser's built-in PDF viewer may block document access.
        // It still opens the exact voucher PDF for printing from its toolbar.
        window.clearInterval(timer);
      }
    }, 700);
    window.setTimeout(() => window.clearInterval(timer), 15000);
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function copyGuestDetails(person: { name: string; dob: string }) {
    const value = [person.name, person.dob === "لم يُعثر عليه" ? "" : person.dob].filter(Boolean).join(" - ");
    try {
      await navigator.clipboard.writeText(value);
      setDiagnosticStatus(`تم نسخ بيانات ${person.name}.`);
    } catch {
      setDiagnosticStatus("تعذر النسخ. تأكد من السماح للمتصفح بالوصول إلى الحافظة.");
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

  async function copyAttachmentDiagnostics() {
    if (!activeAttachment || !selected) return;
    setDiagnosticStatus("جارٍ تجهيز بيانات المرفق للتشخيص...");
    try {
      const extension = activeAttachment.name.split(".").pop()?.toLowerCase() || "";
      const diagnostic: Record<string, unknown> = {
        sourceFileName: selected.name,
        company: selected.company,
        attachmentName: activeAttachment.name,
        attachmentType: activeAttachment.type || "application/octet-stream",
        attachmentSize: activeAttachment.size,
      };

      if (extension === "pdf" || activeAttachment.type === "application/pdf") {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({
          data: new Uint8Array(await activeAttachment.blob.arrayBuffer()),
        }).promise;
        const pages = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
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
          const viewport = page.getViewport({ scale: 1 });
          pages.push({
            page: pageNumber,
            pageSize: { width: viewport.width, height: viewport.height },
            extractedText: textContent.items.map((item) => ("str" in item ? item.str : "")).join(" "),
            textItemsWithCoordinates: items,
          });
        }
        diagnostic.pageCount = pdf.numPages;
        diagnostic.pages = pages;
      } else if (extension === "docx") {
        const mammoth = await import("mammoth/mammoth.browser");
        const result = await mammoth.extractRawText({
          arrayBuffer: await activeAttachment.blob.arrayBuffer(),
        });
        diagnostic.extractedText = result.value || "";
        diagnostic.pages = [{ page: 1, extractedText: result.value || "" }];
      } else if (["txt", "csv", "xml", "html", "htm", "eml", "log"].includes(extension)) {
        const extractedText = await activeAttachment.blob.text();
        diagnostic.extractedText = extractedText;
        diagnostic.pages = [{ page: 1, extractedText }];
      } else {
        diagnostic.note = "لا تتوفر حالياً قراءة نصية لهذا النوع من المرفقات؛ تم تضمين بيانات الملف الأساسية فقط. قد يحتاج الملف المصور إلى OCR.";
      }

      await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2));
      setDiagnosticStatus("تم نسخ بيانات المرفق للتشخيص. الصقها هنا في المحادثة بعد مراجعتها.");
    } catch (error) {
      setDiagnosticStatus(error instanceof Error
        ? "تعذر تجهيز بيانات المرفق: " + error.message
        : "تعذر نسخ بيانات المرفق. تأكد من السماح للمتصفح بالوصول إلى الحافظة.");
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
              {(() => {
                // Preview extracted guests for every company using the same
                // company-specific parser used by the document preview.
                const pagesToParse = item.matchedPages.length
                  ? item.matchedPages.map((pageNumber) => item.pages[pageNumber - 1]).filter(Boolean)
                  : [item.pages[0] || ""];
                const guests = pagesToParse.flatMap((pageText) =>
                  extractPeople(pageText, query, item.company),
                );
                const uniqueGuests = guests.filter((person, index, all) =>
                  all.findIndex((candidate) =>
                    normalize(candidate.name) === normalize(person.name)
                    && normalize(candidate.dob) === normalize(person.dob),
                  ) === index,
                );
                if (!uniqueGuests.length) return null;
                return (
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "#f5f8fc", border: "1px solid #dbe4ef" }}>
                    <strong style={{ display: "block", marginBottom: 7 }}>الأسماء المستخرجة تلقائياً: {uniqueGuests.length}</strong>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "5px 12px" }} dir="ltr">
                      {uniqueGuests.map((person, index) => (
                        <span key={index} style={{ fontSize: 13, textAlign: "left" }}>{person.name}{person.dob ? " - " + person.dob : ""}</span>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </article>
          ))}</div> : <p className="empty-exclusions">لا توجد ملفات تحتوي على كلمة البحث.</p>}
        </section>}
      </>}

      {selected && <section className="panel" aria-label="الأسماء وتواريخ الميلاد في الصفحة الحالية">
        <div style={{ marginTop: 18 }}>
          <h3>الأسماء وتواريخ الميلاد في الصفحة الحالية</h3>
          {extractedPeople.length ? <div className="folder-results">{extractedPeople.map((person, index) => (
            <div className="folder-result" key={index} dir="ltr" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, textAlign: "left", fontWeight: 700 }}>
              <span>{selected.company.toLocaleLowerCase() === "easy jet" || !person.dob || person.dob === "لم يُعثر عليه" ? person.name : selected.company.toLocaleLowerCase() === "pegas" ? (person.name + " " + person.dob) : (person.name + " - " + person.dob)}</span>
              <button type="button" onClick={() => void copyGuestDetails(person)} title={`نسخ بيانات ${person.name}`} aria-label={`نسخ بيانات ${person.name}`} style={{ flex: "0 0 34px", width: 34, height: 34, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px solid #e45b65", borderRadius: 7, background: "#fff", color: "#d93645", cursor: "pointer" }}>
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/></svg>
              </button>
            </div>
          ))}</div> : <p className="empty-exclusions">لم يتم العثور على اسم وتاريخ ميلاد بصيغة معروفة في نص هذه الصفحة. قد يحتاج المستند إلى مراجعة يدوية أو OCR إذا كان ممسوحاً ضوئياً.</p>}
          <p className="saved-hint">يتم استخراج البيانات من النص الموجود في الصفحة المحددة فقط. راجع النتيجة قبل اعتمادها.</p>
        </div>
      </section>}

      {selected && <section className="panel" aria-label="معاينة المستند">
        <div className="section-heading">
          <div><h2>4. معاينة المستند واستخراج البيانات</h2>
            <p className="muted">{selected.name} · {selected.company}</p></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {selected.extension === "msg" ? <>
              <button type="button" className="add-button" onClick={openOriginalMsgInOutlook}>فتح في Outlook</button>
              <button type="button" className="add-button" onClick={downloadOriginalMsg}>تنزيل الملف الأصلي</button>
              <button type="button" className="add-button" onClick={printVoucher} disabled={!msgPreview?.attachments.some((attachment) => attachment.type === "application/pdf" || attachment.name.toLowerCase().endsWith(".pdf"))}>طباعة الفاوتشر</button>
            </> : selected.extension === "pdf" ? <button type="button" className="add-button" onClick={printVoucher}>طباعة الفاوتشر</button> : null}
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
                      {attachment.type.startsWith("image/") ? (
                        <button type="button" onClick={() => { setActiveAttachment(attachment); setAttachmentSearchQuery(""); setAttachmentSearchMatches([]); setAttachmentSearchStatus(""); setActiveAttachmentPage(1); setAttachmentPdfSearchTerm(""); }}
                          aria-label={`معاينة الصورة ${attachment.name}`}
                          style={{ display: "block", width: "100%", padding: 0, marginBottom: 9, border: "1px solid #e2e8f0", borderRadius: 6, background: "#f8fafc", cursor: "zoom-in", overflow: "hidden" }}>
                          <img src={attachment.url} alt={attachment.name} loading="lazy"
                            style={{ display: "block", width: "100%", height: 150, objectFit: "contain" }} />
                        </button>
                      ) : null}
                      <div style={{ fontSize: 12, overflowWrap: "anywhere", marginBottom: 8 }}>📎 {attachment.name}<div style={{ color: "#778399", marginTop: 3 }}>{formatSize(attachment.size)}</div></div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button type="button" className="add-button" onClick={() => { setActiveAttachment(attachment); setAttachmentSearchQuery(""); setAttachmentSearchMatches([]); setAttachmentSearchStatus(""); setActiveAttachmentPage(1); setAttachmentPdfSearchTerm(""); }}>{attachment.type.startsWith("image/") ? "تكبير الصورة" : "فتح / عرض"}</button>
                        {attachment.type.startsWith("image/") && <button type="button" className="add-button" onClick={() => printMsgImage(attachment)}>طباعة الصورة</button>}
                        <button type="button" className="add-button" onClick={() => downloadMsgAttachment(attachment)}>تنزيل</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div> : <p style={{ padding: "12px 18px", margin: 0, color: "#64748b" }}>لا تحتوي الرسالة على مرفقات.</p>}
              {activeAttachment && <div style={{ padding: 14, borderBottom: "1px solid #d5dce5", background: "#f4f7fb" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <strong>{activeAttachment.name}</strong>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" className="add-button" onClick={() => void copyAttachmentDiagnostics()}>نسخ بيانات المرفق للتشخيص</button>
                    <button type="button" className="add-button" onClick={() => { setActiveAttachment(null); setAttachmentSearchMatches([]); setAttachmentSearchStatus(""); setAttachmentPdfSearchTerm(""); }}>إغلاق المرفق</button>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, marginBottom: 12, direction: "rtl" }}>
                  <input value={attachmentSearchQuery} onChange={(event) => setAttachmentSearchQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") void searchInsideAttachment(); }}
                    placeholder="ابحث داخل المرفق بالاسم أو رقم الحجز..."
                    aria-label="البحث داخل المرفق بالاسم أو رقم الحجز"
                    style={{ width: "100%", minHeight: 42, border: "1px solid #cbd6e2", borderRadius: 8, padding: "8px 12px", font: "inherit" }} />
                  <button type="button" className="add-button" onClick={() => void searchInsideAttachment()}>بحث داخل المرفق</button>
                </div>
                {attachmentSearchStatus && <p role="status" style={{ margin: "0 0 10px", color: "#526174", direction: "rtl" }}>{attachmentSearchStatus}</p>}
                {attachmentSearchMatches.length > 0 && <div style={{ display: "grid", gap: 7, marginBottom: 12, direction: "rtl" }}>
                  {attachmentSearchMatches.map((match) => (
                    <button key={match.page} type="button" className="add-button" onClick={() => setActiveAttachmentPage(match.page)}
                      style={{ textAlign: "right", whiteSpace: "normal" }}>
                      صفحة {match.page}: {match.excerpt}
                    </button>
                  ))}
                </div>}
                {activeAttachment.type.startsWith("image/") ? <img src={activeAttachment.url} alt={activeAttachment.name} style={{ maxWidth: "100%", maxHeight: 560, objectFit: "contain" }} /> :
                  activeAttachment.type === "application/pdf" ? <iframe title={activeAttachment.name} src={activeAttachment.url + "#page=" + activeAttachmentPage + "&toolbar=1&zoom=150" + (attachmentPdfSearchTerm ? "&search=" + encodeURIComponent(attachmentPdfSearchTerm) : "")} style={{ width: "100%", height: 600, border: 0, background: "white" }} /> :
                  activeAttachment.type.startsWith("text/") ? <iframe title={activeAttachment.name} src={activeAttachment.url} style={{ width: "100%", height: 400, border: 0, background: "white" }} /> :
                  <p>لا تتوفر معاينة داخلية لهذا النوع من الملفات. يمكنك تنزيله وفتحه بالبرنامج المناسب.</p>}
              </div>}
              <div style={{ padding: 22, minHeight: 180, fontFamily: "Arial,sans-serif", fontSize: 14, lineHeight: 1.55, overflowWrap: "anywhere" }}>
                {msgPreview.bodyHtml ? <iframe title="محتوى رسالة Outlook" sandbox="" srcDoc={msgPreview.bodyHtml} style={{ width: "100%", minHeight: 360, border: 0, background: "white" }} /> :
                  <pre style={{ whiteSpace: "pre-wrap", font: "inherit", margin: 0 }}>{msgPreview.bodyText || "لا يوجد محتوى نصي في الرسالة."}</pre>}
              </div>
            </>}
          </div>
        ) : (
          // Non-Outlook files use the regular PDF/text preview.
          <div style={{ border: "1px solid #d7dee8", borderRadius: 10, overflow: "hidden", background: "#f3f5f7" }}>
            {selected.extension === "pdf" ? <iframe title="معاينة ملف PDF" src={previewUrl + "#page=" + currentPage + "&toolbar=1"}
              style={{ width: "100%", height: "75vh", maxHeight: 850, minHeight: 560, border: 0 }} /> :
              <pre style={{ whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 600, padding: 18, direction: "rtl", background: "white" }}>{pageText || "لا يوجد نص قابل للعرض."}</pre>}
          </div>
        )}
          {diagnosticStatus && <p className="saved-hint" role="status">{diagnosticStatus}</p>}
          <p className="saved-hint">تنبيه: قد تتضمن البيانات المنسوخة أسماء النزلاء وأرقام جوازات السفر؛ راجعها واحذف أي بيانات لا ترغب في مشاركتها قبل إرسالها.</p>
      </section>}

      {warnings.length > 0 && <section className="panel"><h2>ملفات تعذرت قراءتها</h2>
        <ul className="steps">{warnings.map((path) => <li key={path} dir="ltr">{path}</li>)}</ul></section>}
      <p className="foot"><a href="/" style={{ color: "#1769aa" }}>العودة إلى أدوات الفندق</a></p>
    </div>
  );
}