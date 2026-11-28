"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFileLibrary } from "../file-library-provider";
import voucherRules from "./voucher-extraction-rules.json";

type IndexedFile = {
  id: string; name: string; path: string; company: string; extension: string;
  day?: string; month?: string;
  size: number; content: string; pages: string[]; visualPages?: string[];
  attachmentPages?: { name: string; pages: string[] }[]; file: File;
};
type SearchResult = IndexedFile & { matchedPages: number[] };
type MsgAttachmentPreview = { name: string; type: string; blob: Blob; url: string; size: number };
type AttachmentSearchMatch = { page: number; excerpt: string };
type MsgPreviewData = { subject: string; sender: string; senderEmail: string; to: string; cc: string; sent: string; bodyHtml: string; bodyText: string; attachments: MsgAttachmentPreview[] };

type ArrivalRecord = { roomNo: string; name: string; confirmationNo: string; arrivalTime: string; company?: string };

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
      const companyText = companyMarker >= 0 ? rowText.slice(companyMarker).replace(/^\s*T\s*-\s*/i, "").trim() : "";
      const company = companyText ? canonicalizeArrivalCompany(companyText) : "";
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
          company: company || undefined,
        });
      }
    }
  }

  // A confirmation number can be shared by different guests/rooms.
  // Deduplicate only identical room + guest + confirmation records.
  const unique = new Map<string, ArrivalRecord>();
  for (const record of records) {
    const key = `${record.roomNo}|${normalize(record.name)}|${record.confirmationNo}`;
    unique.set(key, record);
  }
  return Array.from(unique.values());
}

const NATIVE_FOLDER_KEY = "long-beach-native-reservation-folder-v1";
const GUEST_STATE_KEY = "nationality-guest-extractor-state-v1";
const SUPPORTED = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "docx", "msg", "txt", "csv", "xml", "html", "htm", "eml", "log"]);
const normalize = (value: string) =>
  value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function canonicalizeArrivalCompany(value: string) {
  const raw = value.replace(/^T\s*-\s*/i, "").trim();
  const cleaned = normalize(raw);
  // Some arrival-report exports append stay dates and operational codes to
  // the supplier name. Resolve known multi-word suppliers before stripping
  // that metadata so all rows group under one canonical company.
  if (/^easy\s*jet(?:\s+tours?)?\b/.test(cleaned)) return "Easy Jet";
  if (/^planet(?:\s+tours?)?\b/.test(cleaned)) return "Planet";
  if (/^house\s+use\b/.test(cleaned)) return "House use";
  if (/^l\s+tur\b/.test(cleaned)) return "L tur";
  if (/^tui(?:\s+destimo)?\b/.test(cleaned)) return "TUI";
  if (/biblio|biblo/.test(cleaned)) return "biblio";
  if (/anex/.test(cleaned)) return "Anex";
  if (/(^|\s)mts(\s|$)/.test(cleaned)) return "MTS";
  if (/odeon/.test(cleaned)) return "Odeon";
  if (/fun\s*sun|funsun/.test(cleaned)) return "FUN&SUN";
  if (/sun international|sunint/.test(cleaned)) return "SUN International";
  if (/w2m|world 2 meet|world2meet/.test(cleaned)) return "W2M";
  if (/tez/.test(cleaned)) return "TEZ";
  if (/travel ways/.test(cleaned)) return "Travel Ways";
  if (/hotel direct/.test(cleaned)) return "Hotel Direct";
  // Generic supplier labels may also be followed by DD-MM-YY dates and
  // reservation/operational metadata. Keep only the company-name prefix.
  return raw.replace(/\s+\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b[\s\S]*$/, "").trim() || raw;
}

function normalizeCompanyKey(value: string) {
  return normalize(canonicalizeArrivalCompany(value)).replace(/\s+/g, "");
}

function getMultipleCompanyQuery(value: string) {
  const key = normalize(value).replace(/\s+/g, "");
  const aliases: Record<string, string> = {
    planet: "Planet", planettours: "Planet",
    w2m: "W2M", world2meet: "W2M",
    tui: "TUI", tuidestimo: "TUI",
    ltur: "L tur",
    biblio: "biblio", biblioglobus: "biblio", biblo: "biblio",
    anex: "Anex", anextours: "Anex",
    mts: "MTS", odeon: "Odeon", tez: "TEZ",
    funsun: "FUN&SUN", suninternational: "SUN International",
  };
  return aliases[key] || "";
}

function isCompanyFolderMatch(fileCompany: string, requestedCompany: string, files: IndexedFile[]) {
  const requested = normalizeCompanyKey(requestedCompany);
  const actual = normalizeCompanyKey(fileCompany);
  if (requested === actual) return true;
  // L tur uses the TUI voucher layout. Fall back to the TUI folder only
  // when the indexed booking tree contains no L tur folder.
  if (requested === "ltur") {
    const hasLturFolder = files.some((file) => normalizeCompanyKey(file.company) === "ltur");
    return !hasLturFolder && actual === "tui";
  }
  return false;
}

function getPreviewMimeType(extension: string) {
  const mimeTypes: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  };
  return mimeTypes[extension.toLowerCase()] || "application/octet-stream";
}

type VoucherRule = { id: string; company: string; aliases: string[]; parser: string; signatures: string[]; bookingIdentifiers: string[]; guestFields: string[] };
const configuredVoucherRules = voucherRules as { version: number; rules: VoucherRule[]; searchFields: string[] };

function isFunSunAlias(value: string) {
  const cleaned = value.replace(/&#x0*20;|&#0*32;|&nbsp;/gi, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return /^(?:fun(?:\s*(?:&|and)?\s*sun)?|fun\s*sun)$/.test(cleaned);
}

function detectVoucherCompany(text: string, currentCompany = "") {
  if (/noreply@w2m\.com|world\s*2\s*meet|world2meet/i.test(text)
    || (/\bBooking\s+Code\b/i.test(text)
      && /\bPassenger\s+Name\b/i.test(text)
      && /\bPassenger\s+Last\s+Name\b/i.test(text))) return "W2M";
  if (/FUN\s*&\s*SUN|FUN\s+SUN|FUN\s+AND\s+SUN|EX\s+TUI\s+RUSSIA/i.test(text) || isFunSunAlias(currentCompany)) {
    return currentCompany && currentCompany !== "غير محددة" ? currentCompany : "FUN&SUN";
  }
  if (currentCompany.trim() && currentCompany.trim() !== "غير محددة") return currentCompany.trim();
  // SUN can be identified from its own branding or its distinctive passenger
  // table, even when the PDF omits the company heading.
  if (/\bSUN\s+INTERNATIONAL\b|\bSUNBUG\b/i.test(text)
    || (/\bHOTEL\s+C\/IN\s+LIST\b/i.test(text)
      && /\bVoucher\b/i.test(text)
      && /\bSurname,\s*Name\b/i.test(text)
      && /\bAge\/B\.Date\b/i.test(text))
    || (/passenger\s+informations/i.test(text)
      && /surname\s*,?\s*name/i.test(text)
      && /\bbirthdate\b/i.test(text)
      && /\btitle\b/i.test(text)
      && /\bage\b/i.test(text))) return "SUN International";
  for (const rule of configuredVoucherRules.rules) {
    if (rule.signatures.length && rule.signatures.every((pattern) => {
      try { return new RegExp(pattern, "i").test(text); } catch { return false; }
    })) return rule.company;
  }
  return currentCompany || "غير محددة";
}

function matchesSearchText(searchableText: string, query: string) {
  const haystack = normalize(searchableText);
  const needle = normalize(query);
  if (!needle) return false;
  const compactNeedle = needle.replace(/\s+/g, "");
  if (/^\d+$/.test(compactNeedle)) return haystack.replace(/\s+/g, "").includes(compactNeedle);
  const tokens = needle.split(/\s+/).filter(Boolean);
  return tokens.length > 1 ? tokens.every((token) => haystack.includes(token)) : haystack.includes(needle);
}


// Arrival reports may contain compound surnames (e.g. "LOPES PEREIRA, Rosa")
// while a supplier voucher may store only "PEREIRA ROSA". Search each
// meaningful name part independently so a missing surname component does not
// hide an otherwise valid booking. Titles and very short tokens are ignored.
const arrivalNameMatchesText = (arrivalName: string, searchableText: string) => {
  const ignored = new Set(["mr", "mrs", "ms", "miss", "mstr", "master", "chd", "child", "inf", "adt", "adult"]);
  const tokens = normalize(arrivalName)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !ignored.has(token));
  if (!tokens.length) return false;
  const searchable = ` ${normalize(searchableText)} `;
  return tokens.some((token) => searchable.includes(` ${token} `));
};

const SUN_IGNORED_TITLE_TOKENS = new Set([
  "mr", "mrs", "ms", "miss", "mstr", "master", "chd", "child", "inf", "adt", "adult",
]);

function getSunSearchTokens(value: string) {
  return normalize(value).split(/\s+/).filter((token) => token && !SUN_IGNORED_TITLE_TOKENS.has(token));
}

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

function getNativeFolderMetadata(relativePath: string): { company: string; day?: string; month?: string } {
  const parts = relativePath.split("/").filter(Boolean);
  const monthIndex = parts.findIndex((part) => MONTH_FOLDER_PATTERN.test(part));
  if (monthIndex >= 0) {
    const dayIndex = monthIndex + 1;
    return {
      month: parts[monthIndex],
      day: /^\\d{1,2}$/.test(parts[dayIndex] || "") ? parts[dayIndex] : undefined,
      company: parts[dayIndex + 1] || parts[dayIndex] || "غير محددة",
    };
  }
  if (/^\\d{1,2}$/.test(parts[0] || "")) {
    return { day: parts[0], company: parts[1] || "غير محددة" };
  }
  return { company: parts.length > 1 ? parts[0] : "غير محددة" };
}

async function extractText(file: File, extension: string): Promise<{ content: string; pages: string[]; visualPages?: string[]; attachmentPages?: { name: string; pages: string[] }[] }> {
  // Images are indexed by filename and previewed directly; OCR is not attempted here.
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"].includes(extension)) {
    return { content: "", pages: [""] };
  }
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
    const htmlBodyValue = (data as unknown as { bodyHtml?: string | Uint8Array; html?: string | Uint8Array }).bodyHtml
      || (data as unknown as { html?: string | Uint8Array }).html;
    const htmlBodyText = htmlBodyValue ? htmlToPlainText(htmlBodyValue) : "";
    let compressedRtfText = "";
    const compressedRtf = (data as unknown as { compressedRtf?: Uint8Array }).compressedRtf;
    if (compressedRtf && compressedRtf.byteLength) {
      try {
        const { decompressRTF } = await import("@kenjiuno/decompressrtf");
        const decompressed = decompressRTF(Array.from(compressedRtf));
        const decodedRtf = rtfToPlainText(new TextDecoder("windows-1252").decode(new Uint8Array(decompressed)));
        compressedRtfText = /<(?:html|body|table|tr|td)\b/i.test(decodedRtf)
          ? htmlToPlainText(decodedRtf)
          : decodedRtf;
      } catch {
        // Some messages contain a corrupt RTF stream; retain their plain/HTML body.
      }
    }
    const fields = [
      data.subject && `الموضوع: ${data.subject}`,
      data.senderName && `المرسل: ${data.senderName}`,
      data.senderEmail && `البريد الإلكتروني: ${data.senderEmail}`,
      data.clientSubmitTime && `تاريخ الإرسال: ${data.clientSubmitTime}`,
      recipientNames.length ? `المستلمون: ${recipientNames.join(", ")}` : "",
      attachmentNames.length ? `المرفقات: ${attachmentNames.join(", ")}` : "",
      typeof data.body === "string" ? data.body : "",
      htmlBodyText,
      compressedRtfText,
      typeof data.headers === "string" ? `\n--- بيانات الرسالة ---\n${data.headers}` : "",
    ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    const content = Array.from(new Set(fields)).join("\n\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
    if (!content || !/[\p{L}\p{N}]/u.test(content)) {
      throw new Error("تعذر استخراج نص مقروء من ملف Outlook MSG.");
    }
    // Index readable PDF attachments as additional searchable pages of the MSG.
    // This makes guest names inside Outlook booking vouchers searchable from
    // the main folder search, not only from the attachment preview.
    const msgReader = message as unknown as {
      getAttachment: (attachment: unknown) => { fileName?: string; content: Uint8Array };
    };
    const attachmentPages: { name: string; pages: string[] }[] = [];
    for (const attachment of attachmentRows) {
      const attachmentName = String(attachment.fileName || attachment.name || "").trim();
      const attachmentExtension = attachmentName.split(".").pop()?.toLowerCase() || "";
      try {
        const extractedAttachment = msgReader.getAttachment(attachment);
        const attachmentBytes = new Uint8Array(extractedAttachment.content);

        const extractedPages: string[] = [];
        if (attachmentExtension === "pdf") {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
          const pdf = await pdfjs.getDocument({ data: attachmentBytes }).promise;
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber);
            const pageContent = await page.getTextContent();
            // Keep PDF table cells in visual reading order (top-to-bottom,
            // then left-to-right). Some suppliers emit DOB cells before the
            // guest-name cells in the PDF's internal object order.
            const positionedItems = pageContent.items
              .filter((item): item is typeof item & { str: string; transform: number[] } =>
                "str" in item && "transform" in item && Boolean(item.str?.trim()))
              .map((item) => ({
                text: item.str.trim(),
                x: item.transform[4],
                y: item.transform[5],
              }));
            const visualRows: { y: number; cells: { x: number; text: string }[] }[] = [];
            for (const item of positionedItems) {
              let row = visualRows.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
              if (!row) {
                row = { y: item.y, cells: [] };
                visualRows.push(row);
              }
              row.cells.push({ x: item.x, text: item.text });
            }
            extractedPages.push(visualRows.sort((a, b) => b.y - a.y).map((row) => row.cells.sort((a, b) => a.x - b.x).map((cell) => cell.text).join(" ")).join("\n"));
          }
        } else if (attachmentExtension === "docx") {
          const mammoth = await import("mammoth/mammoth.browser");
          const result = await mammoth.extractRawText({
            arrayBuffer: attachmentBytes.buffer.slice(
              attachmentBytes.byteOffset,
              attachmentBytes.byteOffset + attachmentBytes.byteLength,
            ) as ArrayBuffer,
          });
          if (result.value?.trim()) extractedPages.push(result.value);
        } else if (["txt", "csv", "xml", "html", "htm", "eml", "log"].includes(attachmentExtension)) {
          const text = new TextDecoder().decode(attachmentBytes);
          if (text.trim()) extractedPages.push(text);
        }        if (extractedPages.length) attachmentPages.push({ name: attachmentName, pages: extractedPages });
      } catch {
        // Keep the MSG searchable even if one attachment cannot be parsed.
      }
    }
    const flattenedAttachmentPages = attachmentPages.flatMap((attachment) => attachment.pages);
    return { content: [content, ...flattenedAttachmentPages].join("\n"), pages: [content, ...flattenedAttachmentPages], attachmentPages };
  }
  if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    const visualPages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const text = await page.getTextContent();
      // Preserve the original flat page text for Single View.
      pages.push(text.items.map((item) => ("str" in item ? item.str : "")).join(" "));

      // Keep a second, visually ordered representation for Multiple View.
      // SUN HOTEL C/IN LIST rows depend on their original table layout.
      const positionedItems = text.items
        .filter((item): item is typeof item & { str: string; transform: number[] } =>
          "str" in item && "transform" in item && Boolean(item.str?.trim()))
        .map((item) => ({
          text: item.str.trim(),
          x: item.transform[4],
          y: item.transform[5],
        }));
      const visualRows: { y: number; cells: { x: number; text: string }[] }[] = [];
      for (const item of positionedItems) {
        let row = visualRows.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
        if (!row) {
          row = { y: item.y, cells: [] };
          visualRows.push(row);
        }
        row.cells.push({ x: item.x, text: item.text });
      }
      visualPages.push(visualRows
        .sort((a, b) => b.y - a.y)
        .map((row) => row.cells.sort((a, b) => a.x - b.x).map((cell) => cell.text).join(" "))
        .join("\n"));
    }
    return { content: pages.join("\n"), pages, visualPages };
  }
  return { content: "", pages: [""] };
}

function titleCaseName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/(^|[\s'-])([\p{L}])/gu,
    (_match, separator: string, letter: string) => separator + letter.toLocaleUpperCase());
}

function htmlToPlainText(value: string | Uint8Array | ArrayBuffer) {
  let html = "";
  if (typeof value === "string") html = value;
  else {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    try { html = new TextDecoder("utf-8").decode(bytes); }
    catch { html = new TextDecoder("windows-1252").decode(bytes); }
  }
  if (!html.trim()) return "";
  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(html, "text/html");
    document.querySelectorAll("script,style,head").forEach((node) => node.remove());
    document.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    document.querySelectorAll("tr").forEach((node) => node.append("\n"));
    document.querySelectorAll("td,th").forEach((node) => node.append(" | "));
    return (document.body.textContent || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  return html.replace(/<\/(?:tr|p|div|li|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}

function rtfToPlainText(value: string) {
  let text = value
    .replace(/\\'[0-9a-f]{2}/gi, (token) => {
      const byte = Number.parseInt(token.slice(2), 16);
      return new TextDecoder("windows-1252").decode(new Uint8Array([byte]));
    })
    .replace(/\\u(-?\d+)\??/g, (_match, raw) => String.fromCharCode((Number(raw) + 65536) % 65536))
    .replace(/\\(?:par|line)\b\s?/gi, "\n")
    .replace(/\\tab\b\s?/gi, "\t")
    .replace(/\\(?:cell|row)\b\s?/gi, " | ")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, " ")
    .replace(/\\[^a-zA-Z]/g, " ")
    .replace(/[{}]/g, " ");
  return text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractW2mPeople(text: string, searchTerm: string) {
  // W2M MSG bodies may contain HTML tables or text with LZFu/binary noise.
  // Normalize the visible text while retaining row and bullet boundaries.
  const clean = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:tr|li|p|div|table|h[1-6])\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n");

  const passengersStart = clean.search(/\bPassengers?\s*:/i);
  const hasPassengersSection = passengersStart >= 0;
  const section = hasPassengersSection ? clean.slice(passengersStart) : "";
  const sectionEnd = section.search(
    /\b(?:Special\s+remarks?|W2M\s+remarks?|Remarks?|Number\s+of\s+Adults?\s*\/\s*Childs?\s*\/\s*Bab(?:y|ies)|Booking\s+Summary|Payment\s+Details|Accommodation|Board)\s*:?/i,
  );
  const passengerText = hasPassengersSection
    ? (sectionEnd > 0 ? section.slice(0, sectionEnd) : section)
    : "";
  // Per the W2M format, the summary-table fallback is used only when the
  // Passengers section is absent; never search hotel remarks for guest names.
  const fallbackStart = clean.search(/\bBooking\s+Summary\b/i);
  const fallbackText = !hasPassengersSection
    ? clean.slice(fallbackStart >= 0 ? fallbackStart : 0)
    : "";
  const sourceText = hasPassengersSection ? passengerText : fallbackText;

  const people: { name: string; dob: string }[] = [];
  const add = (name: string, detail = "") => {
    const normalizedName = name.replace(/\s+/g, " ").replace(/^[*•\-\s]+|[|,;\s]+$/g, "").trim();
    if (!normalizedName || normalizedName.split(/\s+/).length < 2) return;
    people.push({ name: titleCaseName(normalizedName), dob: detail.trim() });
  };

  if (hasPassengersSection) {
    // Passenger rows: "* Full Name (Age: 21)", DOB, or a bare date.
    const bulletPattern = /(?:^|\n|\s)[*•]\s*([\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*){1,7})\s*(?:\(\s*(?:Age\s*:\s*(\d{1,3})|(?:DOB|Birth\s*date|Date\s*of\s*birth)\s*:\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}))\s*\)|[-|]\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})|\(\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s*\))?/giu;
    for (const match of passengerText.matchAll(bulletPattern)) {
      add(match[1], match[2] ? "(Age: " + match[2] + ")" : match[3] || match[4] || "");
    }

    const unbulletedPattern = /(?:^|\n)\s*([\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*){1,7})\s*(?:\(\s*(?:Age\s*:\s*(\d{1,3})|(?:DOB|Birth\s*date|Date\s*of\s*birth)\s*:\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}))\s*\)|[-|]\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})|\(\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s*\))/giu;
    if (!people.length) {
      for (const match of passengerText.matchAll(unbulletedPattern)) {
        add(match[1], match[2] ? "(Age: " + match[2] + ")" : match[3] || match[4] || "");
      }
    }
  }

  // Fallback table: separate Passenger Name / Passenger Last Name columns.
  const lines = sourceText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const headerIndex = lines.findIndex((line) =>
    /Passenger\s+Name/i.test(line) && /Passenger\s+Last\s+Name/i.test(line),
  );
  if (headerIndex >= 0) {
    const header = lines[headerIndex].split(/\s*\|\s*|\t+|\s{2,}/).map(normalize);
    const firstIndex = header.findIndex((cell) => /passenger name|first name|given name/.test(cell));
    const lastIndex = header.findIndex((cell) => /passenger last name|last name|surname/.test(cell));
    const ageIndex = header.findIndex((cell) => /^age$/.test(cell));
    const dobIndex = header.findIndex((cell) => /birth|dob|date of birth/.test(cell));
    for (const line of lines.slice(headerIndex + 1)) {
      if (/^(number of adults|special remarks|w2m remarks|remarks|booking summary|payment details)/i.test(line)) break;
      const cells = line.split(/\s*\|\s*|\t+|\s{2,}/).map((cell) => cell.trim());
      if (firstIndex < 0 || lastIndex < 0 || !cells[firstIndex] || !cells[lastIndex]) continue;
      const dob = dobIndex >= 0 ? cells[dobIndex] || "" : "";
      const age = ageIndex >= 0 ? cells[ageIndex] || "" : "";
      add(cells[firstIndex] + " " + cells[lastIndex], dob.match(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/)?.[0]
        || (age.match(/^\d{1,3}$/) ? "(Age: " + age + ")" : ""));
    }
  }

  if (!people.length && !hasPassengersSection) {
    // Summary fallback only: accept the explicit first/last-name labels.
    const rowPattern = /(?:Passenger\s+Name|First\s+Name)\s*:?\s*([\p{L}\p{M}'’.-]+)[\s|,]+(?:Passenger\s+Last\s+Name|Last\s+Name|Surname)\s*:?\s*([\p{L}\p{M}'’.-]+)(?:[\s|,]+(?:Age\s*:?\s*(\d{1,3})|(?:DOB|Birth\s*date|Date\s*of\s*birth)\s*:?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})))?/giu;
    for (const match of fallbackText.matchAll(rowPattern)) {
      add(match[1] + " " + match[2], match[3] ? "(Age: " + match[3] + ")" : match[4] || "");
    }
  }

  // A W2M email represents one booking and its Passengers block is the
  // authoritative guest list. The search may be a hotel arrival-list name
  // in "SURNAME, GIVEN, TITLE" order, which does not match W2M's full-name
  // order; once the MSG itself is selected, return all passengers in it.
  return people;
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

function extractTravelWaysPeople(text: string, searchTerm: string) {
  // Travel Ways EBD reports repeat the booking voucher only on the first
  // guest row. Attach subsequent titled DOB rows to that same booking.
  type BookingGroup = { voucher: string; people: { name: string; dob: string }[] };
  const groups: BookingGroup[] = [];
  let current: BookingGroup | null = null;

  const parseGuestRow = (line: string) => {
    const match = line.match(
      /^\s*(?:MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHILD|INF)\.?\s+(.+?)\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?=\s|$)/i,
    );
    if (!match) return null;
    const name = match[1].replace(/\s+/g, " ").trim();
    if (!name || /^(?:surname,? name|total pax|total room)$/i.test(name)) return null;
    return { name: titleCaseName(name), dob: match[2].replace(/[/-]/g, ".") };
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const bookingStart = line.match(/^([A-Z][A-Z0-9_-]{1,12})\s+([A-Z0-9-]{5,})\s+\d+\s+(.+)$/i);
    if (bookingStart) {
      if (current?.people.length) groups.push(current);
      current = { voucher: bookingStart[2], people: [] };
      const firstGuest = parseGuestRow(bookingStart[3]);
      if (firstGuest) current.people.push(firstGuest);
      continue;
    }

    if (!current) continue;
    const continuationGuest = parseGuestRow(line);
    if (continuationGuest) {
      current.people.push(continuationGuest);
      continue;
    }

    if (/^(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}\s+Totals|Total\s+(?:Pax|Room)\s*:|NOTE:)/i.test(line)) {
      if (current.people.length) groups.push(current);
      current = null;
    }
  }
  if (current?.people.length) groups.push(current);

  const query = normalize(searchTerm);
  if (!query) return groups.flatMap((group) => group.people);
  const compactQuery = query.replace(/\s+/g, "");
  const nameTokens = query.split(/\s+/).filter(
    (token) => token.length > 1 && !/^(?:mr|mrs|ms|miss|mstr|master|chd|child|inf)$/i.test(token),
  );
  const matchingGroups = groups.filter((group) => {
    const voucher = normalize(group.voucher).replace(/\s+/g, "");
    if (compactQuery === voucher) return true;
    return group.people.some((person) => {
      const name = normalize(person.name);
      return name.includes(query) || (nameTokens.length > 0 && nameTokens.every((token) => name.includes(token)));
    });
  });
  return matchingGroups.flatMap((group) => group.people);
}

function isPlanetIndexedFile(file: Pick<IndexedFile, "company" | "name" | "path" | "content" | "pages" | "attachmentPages"> | null | undefined) {
  if (!file) return false;
  const company = normalize(file.company);
  const searchable = [file.name, file.path, file.content, ...file.pages,
    ...(file.attachmentPages || []).flatMap((attachment) => [attachment.name, ...attachment.pages])].join(" ");
  return company === "planet" || /\bplanet\s+tours?\b/i.test(searchable)
    || (/\bHOTEL\s+(?:RESERVATION\s+FORM|C\/IN\s+LIST)\b/i.test(searchable)
      && /\b(?:RAINBOW|RAIN)\s+\d{5,10}\s+\d+\s+(?:MR|MRS|MS|MISS|CHD)\b/i.test(searchable));
}

function extractPlanetPeople(pages: string[], searchTerm: string) {
  type PlanetBooking = { voucher: string; people: MultipleGuest[] };
  const groups: PlanetBooking[] = [];
  const byVoucher = new Map<string, PlanetBooking>();
  let current: PlanetBooking | null = null;
  let lastPerson: MultipleGuest | null = null;

  const addGuest = (raw: string, group: PlanetBooking): MultipleGuest | null => {
    const guest = raw.match(/\b(MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHILD|INF)\.?\s+(.+?)(?=\s+\d{1,2}[./-]\d{1,2}[./-]\d{4}\b|\s+(?:ARR\b|ENT\d|SINGLE\s+ROOM|DOUBLE\s+ROOM|TRIPLE\s+ROOM|QUAD\s+ROOM)\b|$)/i);
    if (!guest) return null;
    const name = guest[2].replace(/\s+/g, " ").replace(/[,.]+$/, "").trim();
    if (!name || /^(?:SURNAME,? NAME|TOTAL PAX|TOTAL ROOM)$/i.test(name)) return null;
    const dob = raw.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/)?.[1] || "";
    const person = { name: titleCaseName(name), dob: dob.replace(/[/-]/g, ".") };
    const existing = group.people.find((item) => normalize(item.name) === normalize(person.name) && item.dob === person.dob);
    if (existing) return existing;
    group.people.push(person);
    return person;
  };

  for (const rawLine of pages.join("\n").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const start = line.match(/^.{0,35}?\b(\d{5,10})\s+\d+\s+((?:MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHILD|INF)\.?\s+.+)$/i);
    if (start) {
      const voucher = start[1];
      current = byVoucher.get(voucher) || { voucher, people: [] };
      if (!byVoucher.has(voucher)) {
        byVoucher.set(voucher, current);
        groups.push(current);
      }
      lastPerson = addGuest(start[2], current);
      continue;
    }
    if (/^(?:NOTE:|TOTAL\s+PAX\b|TOTAL\s+ROOM\b|LONG\s+BEACH\s+HOTEL\s+TOTALS?)/i.test(line)) {
      current = null;
      lastPerson = null;
      continue;
    }
    if (current && /^(?:MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHILD|INF)\.?\s+/i.test(line)) {
      lastPerson = addGuest(line, current);
    } else if (current && lastPerson && line.length >= 4
      && /^[\p{L}][\p{L}'’.-]{2,40}$/u.test(line)
      && line === line.toLocaleUpperCase()) {
      // Some Planet PDFs wrap a long surname onto its own visual line.
      lastPerson.name = titleCaseName(lastPerson.name + " " + line);
    }
  }

  const query = normalize(searchTerm);
  if (!query) return groups.flatMap((group) => group.people);
  const compactQuery = query.replace(/\s+/g, "");
  if (/^\d{5,10}$/.test(compactQuery)) {
    const exact = groups.find((group) => group.voucher === compactQuery);
    if (exact) return exact.people;
  }
  const queryTokens = query.split(/\s+/).filter((token) =>
    token.length >= 3 && !/^(?:mr|mrs|ms|miss|mstr|master|chd|child|inf|adult|adt)$/i.test(token),
  );
  const matchingGroups = groups.filter((group) => {
    const nameTokens = normalize(group.people.map((person) => person.name).join(" ")).split(/\s+/);
    if (!queryTokens.length) return false;
    return queryTokens.length === 1
      ? nameTokens.includes(queryTokens[0])
      : queryTokens.every((token) => nameTokens.includes(token));
  });
  return matchingGroups.flatMap((group) => group.people);
}

function extractPeople(text: string, searchTerm: string, company = "", enableSunCheckInList = false, preserveDuplicateNames = false) {
  company = detectVoucherCompany(text, company);

  // MTS / OTS Guest Voucher: traveller rows may include a title, omit it,
  // or use Dutch titles such as "de heer". Examples:
  // 1. Herr Spiegel Kevin (19.Jul.1997), 1. Solina Natalia (30),
  // 3. de heer Nabben Laurence (15.Jul.1969).
  if (/\b(?:Voucher\s+)?Reference\s+No\.?\s*:/i.test(text) && /\bTravellers?\s*:/i.test(text)) {
    const travellerSection = text.match(/\bTravellers?\s*:\s*\d+\s+persons?\s*([\s\S]*?)(?=\bDates\s*:|$)/i)?.[1] || "";
    const mtsRow = /(?:^|\n)\s*\d{1,2}\s*[.)-]\s*([^\r\n(]+?)\s*\(\s*(\d{1,2}\s*[.\/-]\s*[A-Za-z]{3,9}\s*[.\/-]\s*\d{4}|\d{1,2}\s*[.\/-]\s*\d{1,2}\s*[.\/-]\s*\d{2,4}|\d{1,3})\s*\)/gim;
    const mtsPeople = Array.from(travellerSection.matchAll(mtsRow), (match) => {
      const value = match[2].replace(/\s+/g, "");
      const isAge = /^\d{1,3}$/.test(value);
      const name = match[1].trim()
        .replace(/^(?:de\s+heer|mevrouw|herr|frau|mr|mrs|ms|miss|mstr|master)\.?\s+/i, "")
        .trim();
      if (!name) return null;
      return {
        name: titleCaseName(name.replace(/\s+/g, " ")),
        dob: isAge ? "(Age: " + value + ")" : value.replace(/[\/-]/g, "."),
      };
    }).filter((person): person is MultipleGuest => Boolean(person));
    if (mtsPeople.length) return mtsPeople;
  }
  const isTravelWaysReport = /travel\s*ways/i.test(company)
    || (/HOTEL\s+CONTRACT\s+EBD\s+LIST/i.test(text)
      && /\bOperator\b[\s\S]{0,250}\bVoucher\b/i.test(text));
  if (isTravelWaysReport) {
    const travelWaysPeople = extractTravelWaysPeople(text, searchTerm);
    if (travelWaysPeople.length) return travelWaysPeople;
  }
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

  // SUN International Outlook attachment: HOTEL C/IN LIST.
  // Voucher identifies a booking; following titled rows without a repeated
  // Voucher belong to it until another booking code appears.
  const isSunCheckInList = /\bHOTEL\s+C\/IN\s+LIST\b/i.test(text)
    && /\bVoucher\b/i.test(text)
    && /\bSurname,\s*Name\b/i.test(text)
    && /\bAge\/B\.Date\b/i.test(text);
  if (isSunCheckInList && enableSunCheckInList) {
    type SunCheckInGroup = { voucher: string; people: { name: string; dob: string }[] };
    const groups: SunCheckInGroup[] = [];
    const groupsByVoucher = new Map<string, SunCheckInGroup>();
    let current: SunCheckInGroup | null = null;
    const titlePattern = /\b(MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHILD|INF)\.?\s+(.+?)(?=\s+ARR\+?\b|\s+(?:SINGLE|DOUBLE|TRIPLE|QUAD)\s+ROOM\b|$)/i;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line) continue;
      const guestMatch = titlePattern.exec(line);
      if (!guestMatch) continue;
      const beforeGuest = line.slice(0, guestMatch.index);
      const voucherMatch = beforeGuest.match(/\b([A-Z0-9]{5,10})\s+\d+\s*$/i)
        || beforeGuest.match(/\b([A-Z0-9]{5,10})\b/i);
      if (voucherMatch) {
        const voucher = voucherMatch[1].toUpperCase();
        current = groupsByVoucher.get(voucher) || { voucher, people: [] };
        if (!groupsByVoucher.has(voucher)) { groupsByVoucher.set(voucher, current); groups.push(current); }
      }
      if (!current) continue;
      // Only read DOB from the guest cell before the ARR/status column.
      // Dates later on the line are arrival/departure dates and must not be used as DOB.
      const guestCell = guestMatch[2].replace(/\s+(?:ARR\+?|NEW|CHANGED)\b.*$/i, "")
        .replace(/\s+(?:SINGLE|DOUBLE|TRIPLE|QUAD)\s+ROOM\b.*$/i, "").trim();
      const dobMatch = guestCell.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/);
      const nameBeforeDob = dobMatch
        ? guestCell.slice(0, dobMatch.index)
        : guestCell.replace(/\s+-\s*$/, "");
      // Age may share the same guest cell with the name and DOB (e.g.
      // "VIVIANA SEYBOLD 36 13.02.1989"); do not append it to the name.
      const rawName = nameBeforeDob.replace(/\s+\d{1,3}\s*\/?\s*$/, "")
        .replace(/\s+/g, " ").replace(/^[,\s]+|[,\s]+$/g, "").replace(/,/g, " ").trim();
      if (!rawName || /^(?:SURNAME NAME|NAME|AGE)$/i.test(rawName)) continue;
      current.people.push({ name: titleCaseName(rawName), dob: dobMatch ? dobMatch[1].replace(/[/-]/g, ".") : "" });
    }

    const normalizedQuery = normalize(searchTerm);
    if (!normalizedQuery) return groups.flatMap((group) => group.people);
    const compactQuery = normalizedQuery.replace(/\s+/g, "");
    if (/^[a-z0-9]{5,10}$/i.test(compactQuery)) {
      const match = groups.find((group) => group.voucher.toLowerCase() === compactQuery.toLowerCase());
      return match?.people || [];
    }
    const searchTokens = getSunSearchTokens(normalizedQuery);
    const matchingGroups = groups.filter((group) => group.people.some((person) => {
      const name = normalize(person.name);
      return name.includes(normalizedQuery)
        || (searchTokens.length > 0 && searchTokens.every((token) =>
          name.split(/\s+/).some((part) => part.includes(token)),
        ));
    }));
    return matchingGroups.flatMap((group) => group.people);
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

  // W2M Outlook bookings are parsed from the fully decoded message body.
  const isW2mBooking = /^w2m$/i.test(company.trim())
    || /noreply@w2m\.com|world\s*2\s*meet|world2meet/i.test(clean)
    || (/\bBooking\s+Code\b/i.test(clean)
      && ((/\bPassenger\s+Name\b/i.test(clean)
        && /\bPassenger\s+Last\s+Name\b/i.test(clean))
        || /\bPassengers?\s*:/i.test(clean)));
  if (isW2mBooking) {
    // Never fall through to generic name guessing for a W2M booking.
    // If its passenger section cannot be parsed, returning no names is safer
    // than treating promotional/special-remarks text as guessed names.
    return extractW2mPeople(text, searchTerm);
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

  // FUN&SUN / FUN voucher:
  // Passenger rows use the columns Title, Surname/Name, Age, Birthdate,
  // Arrival, Hour, Departure, Hour, Passport. The flight and passport
  // columns follow the DOB, so the generic titled-name parser cannot
  // safely identify the end of a guest row. Anchor each guest on its DOB.
  const isFunSunVoucher = /(?:FUN\s*&\s*SUN|FUN\s+SUN|FUN\s+SUN\s+TRAVEL|EX\s+TUI\s+RUSSIA)/i.test(clean)
    || /^fun(?:\s*\&?\s*sun)?$/i.test(company.trim());
  if (isFunSunVoucher && /\bPassenger\s+Informations\b/i.test(clean)
    && /\bBirthdate\b/i.test(clean)) {
    const passengerStart = clean.search(/\bPassenger\s+Informations\b/i);
    const passengerSection = clean.slice(passengerStart)
      .replace(/^Passenger\s+Informations\b/i, "")
      .split(/\b(?:Agency\s+Note|Hotel\s+Notes|Agency\s+Name|Agency\s+User|Sejour\s+Hotel\s+Name)\b/i)[0];
    const funSunRowPattern = /(?:^|\s)(?:MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHILD|INF|ADT)\.?\s+([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*){1,3})\s*(?:-\s*)?(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/giu;
    const funSunPeople = Array.from(passengerSection.matchAll(funSunRowPattern), (match) => ({
      name: titleCaseName(match[1].replace(/[,]+/g, " ").replace(/\s+/g, " ").trim()),
      dob: match[2].replace(/[/-]/g, "."),
    })).filter((person) => person.name && !/^(?:passenger informations|surname name|name age|age)$/i.test(person.name));

    if (funSunPeople.length) {
      const normalizedSearch = normalize(searchTerm);
      const compactSearch = normalizedSearch.replace(/\s+/g, "");
      // Room/confirmation searches identify the voucher in Multiple View;
      // return every passenger in that voucher. A name search must also
      // return the complete passenger group once any guest matches.
      const matchesVoucher = !normalizedSearch
        || /^\d{3,9}$/.test(compactSearch)
        || funSunPeople.some((person) => {
          const nameParts = normalize(person.name).split(/\s+/).filter(Boolean);
          const queryParts = getSunSearchTokens(normalizedSearch);
          return normalize(person.name).includes(normalizedSearch)
            || (queryParts.length > 0 && queryParts.every((token) =>
              nameParts.some((part) => part.includes(token)),
            ));
        });
      return matchesVoucher ? funSunPeople : [];
    }
  }

  // SUN International / Sunbug / Hotel2Sejour passenger table.
  // The table headings are sufficient to identify this format even when the
  // supplier/company heading or the "Passenger Informations" label is absent
  // from PDF text extraction.
  const sunSectionIndex = clean.search(/passenger\s+informations/i);
  const hasSunPassengerColumns = /surname\s*,?\s*name/i.test(clean)
    && /\bbirthdate\b/i.test(clean)
    && /\btitle\b/i.test(clean)
    && /\bage\b/i.test(clean);
  if (hasSunPassengerColumns) {
    const passengerSection = (sunSectionIndex >= 0 ? clean.slice(sunSectionIndex) : clean)
      .split(/\b(?:Agency\s+Note|Hotel\s+Notes|Agency\s+Name|Agency\s+User|Sejour\s+Hotel\s+Name)\b/i)[0];
    // Row order: Title, Surname/Name, Age, Birthdate. A dash is a real empty
    // field, not a reason to drop the passenger or infer a date.
    const sunRowPattern = /\b(?:MRS|MR|MS|MISS|MSTR|MASTER|CHD|CHILD|INF|ADT|ADULT)\.?\s+([\p{L}][\p{L}\p{M}\s,.'’\-]{1,65}?)\s+(-|\d{1,3})\s+(-|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?=\s|$)/giu;
    const sunPeople = Array.from(passengerSection.matchAll(sunRowPattern), (match) => ({
      name: titleCaseName(match[1].replace(/\s+/g, " ").replace(/^[,\s]+|[,\s]+$/g, "").trim()),
      // Empty DOB stays empty; the SUN card renderer displays the required
      // trailing hyphen without inventing a date.
      dob: match[3] === "-" ? "" : match[3].replace(/[.-]/g, "/"),
    })).filter((person) => person.name && !/^(?:surname name|name|age)$/i.test(person.name));
    if (sunPeople.length) {
      const normalizedSearch = normalize(searchTerm);
      const searchTokens = getSunSearchTokens(normalizedSearch);
      const matchesVoucher = !normalizedSearch
        || /^\d{5,12}$/.test(normalizedSearch.replace(/\s+/g, ""))
        || sunPeople.some((person) => normalize(person.name).includes(normalizedSearch)
          || (searchTokens.length > 0 && searchTokens.every((token) =>
            normalize(person.name).split(/\s+/).some((part) => part.includes(token)),
          )));
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

  // Generic hotel rooming-list attachment fallback.
  // Some supplier PDFs place the guest name and DOB in separate visual rows.
  // Extract the titled name independently; attach a DOB only when it follows
  // that same name before another guest/title or booking field begins.
  const titledAttachmentPattern = /\\b(MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHLD)\\.?\\s+([\\p{L}][\\p{L}’'.,-]*(?:\\s+[\\p{L}][\\p{L}’'.,-]*){1,4}?)(?:\\s+(\\d{1,2}[./-]\\d{1,2}[./-]\\d{4})\\b)?(?=\\s+(?:MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHLD)\\b|\\s+\\d{1,2}:\\d{2}\\b|\\s+[A-Z]{1,3}\\d{4,}\\b|\\s+passport\\b|$)/giu;
  const titledAttachmentPeople = Array.from(clean.matchAll(titledAttachmentPattern), (match) => ({
    name: titleCaseName(match[2].replace(/[,]+/g, " ").trim()),
    dob: match[3] ? match[3].replace(/[/-]/g, ".") : "",
  })).filter((person) => person.name && !/^(?:DOUBLE ROOM|STANDARD|PREMIUM)$/i.test(person.name));
  if (titledAttachmentPeople.length) {
    const normalizedSearch = normalize(searchTerm);
    if (!normalizedSearch || /^\\d{3,9}$/.test(normalizedSearch.replace(/\\s+/g, ""))) {
      return titledAttachmentPeople;
    }
    const tokens = normalizedSearch.split(/\\s+/)
      .filter((token) => !/^(?:mr|mrs|ms|miss|mstr|master|chd|chld)$/.test(token));
    const matchingPeople = titledAttachmentPeople.filter((person) => {
      const parts = normalize(person.name).split(/\\s+/);
      return normalize(person.name).includes(normalizedSearch)
        || (tokens.length > 0 && tokens.every((token) => parts.some((part) => part.includes(token))));
    });
    if (matchingPeople.length) return matchingPeople;
  }

  const datePattern = "(?:\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4}|\\d{4}[\\/-]\\d{1,2}[\\/-]\\d{1,2}|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4})";
  const dates: string[] = [];
  const dateRegex = new RegExp("(?:date\\s*of\\s*birth|birth\\s*date|dob|d\\.o\\.b\\.?|تاريخ\\s*الميلاد)\\s*[:#-]?\\s*(" + datePattern + ")", "gi");
  for (const match of clean.matchAll(dateRegex)) dates.push(match[1]);
  const ages: string[] = [];
  if (preserveDuplicateNames) {
    const ageRegex = /(?:\bage\b|years?\s*old)\s*[:#-]?\s*(\d{1,3})|\((\d{1,3})\)/gi;
    for (const match of clean.matchAll(ageRegex)) ages.push(match[1] || match[2]);
  }
  const names: string[] = [];
  const nameRegex = /(?:guest\s*name|passenger\s*name|full\s*name|name\s*of\s*guest|guest|passenger|الاسم|اسم\s*النزيل)\s*[:#-]?\s*([\p{L}][\p{L}\s'.-]{2,60}?)(?=\s+(?:date\s*of\s*birth|birth\s*date|dob|d\.o\.b\.?|passport|nationality|room|تاريخ\s*الميلاد)\b|[,;|]|$)/giu;
  for (const match of clean.matchAll(nameRegex)) {
    const candidate = match[1].trim();
    if (candidate && (preserveDuplicateNames || !names.some((name) => normalize(name) === normalize(candidate)))) names.push(candidate);
  }
  if (!names.length && searchTerm.trim()) {
    const escaped = searchTerm.trim().replace(/[.*+?^\x24{}()|[\]\\]/g, "\\$&");
    const found = clean.match(new RegExp(escaped, "i"));
    if (found) names.push(found[0]);
  }
  return names.map((name, index) => ({
    name: titleCaseName(name),
    dob: dates[index] || (dates.length === 1 ? dates[0] : ages[index] ? "(Age: " + ages[index] + ")" : "لم يُعثر عليه"),
  }));
}


type SunIndexedFile = Pick<IndexedFile, "extension" | "pages" | "visualPages" | "content" | "company" | "name" | "path">;

function isAnexIndexedFile(file: Pick<IndexedFile, "company" | "content" | "pages" | "path"> | null | undefined) {
  if (!file) return false;
  return /\\banex(?:\\s*tour)?\\b/i.test(file.company)
    || /\\banex(?:\\s*tour)?\\b/i.test(file.path)
    || /\\bclients\\s*names\\s*,?\\s*citizenship\\b/i.test(file.content + " " + file.pages.join(" "));
}

function isW2mIndexedFile(file: Pick<IndexedFile, "company" | "content" | "pages"> | null | undefined) {
  if (!file) return false;
  return /^w2m$/i.test(file.company.trim())
    || /noreply@w2m\.com|world\s*2\s*meet|world2meet/i.test([file.content, ...file.pages].join(" "));
}

function isMtsIndexedFile(file: Pick<IndexedFile, "company" | "content" | "pages" | "name" | "path"> | null | undefined) {
  if (!file) return false;
  const company = normalize(file.company);
  const searchable = [file.name, file.path, file.content, ...file.pages].join(" ");
  return company === "mts" || company.startsWith("mts ") || /\bmts\s*globe\b|mtsglobe/i.test(searchable);
}

function isSunInternationalIndexedFile(file: SunIndexedFile | null | undefined) {
  if (!file) return false;
  const company = normalize(file.company);
  const searchable = [file.name, file.path, file.content, ...file.pages, ...(file.visualPages || [])].join(" ");
  const isFunSun = isFunSunAlias(file.company)
    || /FUN\s*&\s*SUN|FUN\s+SUN|FUN\s+AND\s+SUN|EX\s+TUI\s+RUSSIA/i.test(searchable);
  if (isFunSun) return false;
  const hasPassengerTable = /passenger\s+informations/i.test(searchable)
    && /surname\s*,?\s*name/i.test(searchable)
    && /\bbirthdate\b/i.test(searchable)
    && /\btitle\b/i.test(searchable)
    && /\bage\b/i.test(searchable);
  const hasCheckInList = /\bHOTEL\s+C\/IN\s+LIST\b/i.test(searchable)
    && /\bVoucher\b/i.test(searchable)
    && /\bSurname,\s*Name\b/i.test(searchable)
    && /\bAge\/B\.Date\b/i.test(searchable);
  return ["sun", "sun international", "sunbug", "sun bug"].includes(company)
    || /\bSUN\s+INTERNATIONAL\b|\bSUNBUG\b/i.test(searchable)
    || hasPassengerTable
    || hasCheckInList;
}

function isFunSunIndexedFile(file: Pick<IndexedFile, "company" | "content" | "pages" | "name" | "path"> | null | undefined) {
  if (!file) return false;
  const searchable = [file.name, file.path, file.content, ...file.pages].join(" ");
  return isFunSunAlias(file.company)
    || /FUN\s*&\s*SUN|FUN\s+SUN|FUN\s+AND\s+SUN|EX\s+TUI\s+RUSSIA/i.test(searchable);
}

function getFunSunFilePriority(file: Pick<IndexedFile, "name" | "extension">) {
  if (file.extension.toLowerCase() !== "pdf") return 5;
  const base = file.name.replace(/\\.pdf$/i, "").trim();
  // Accept AMEND / AMMEND, optional dot/space, and + or - before the suffix.
  if (/^\\d+[\\s._+-]*am+end$/i.test(base)) return 0;
  if (/^\\d{5,12}$/.test(base)) return 1;
  if (/^\\d{5,12}(?:[,_\\s-].+|[+-].+)$/i.test(base)) return 2;
  if (/^reservations\\s*\\(\\s*\\d+\\s*\\)$/i.test(base)
    || /^download$/i.test(base)
    || /^hotel2sejour$/i.test(base)) return 3;
  return 4;
}

/**
 * Parse SUN batch PDFs page-by-page so a name or reservation search returns
 * only the matching reservation page(s), not passengers from every booking
 * in Hotel2Sejour / Final / Reservations files. For MSG files, inspect PDF
 * attachment pages before falling back to the email body.
 */
function extractPeopleForMultipleView(
  file: Pick<IndexedFile, "extension" | "pages" | "visualPages" | "content" | "company" | "name" | "path" | "attachmentPages">,
  searchTerm: string,
  enableSunCheckInList = false,
) {
  const isMsg = file.extension.toLowerCase() === "msg";
  const isSun = isSunInternationalIndexedFile(file);
  const isMts = isMtsIndexedFile(file);
  if (isPlanetIndexedFile(file)) {
    const sourcePages = isMsg
      ? (file.attachmentPages || []).filter((attachment) => /\.pdf$/i.test(attachment.name)).flatMap((attachment) => attachment.pages)
      : (file.visualPages?.length ? file.visualPages : file.pages);
    return extractPlanetPeople(sourcePages, searchTerm);
  }

  // W2M sends the authoritative guest list in the Outlook email body under
  // "Passengers:". Parse that body directly before generic supplier logic;
  // do not let promotional text in Special remarks become guessed names.
  if (isW2mIndexedFile(file)) {
    const source = isMsg
      ? (file.pages[0] || file.content || "")
      : (file.visualPages?.length ? file.visualPages.join("\n") : file.pages.join("\n")) || file.content || "";
    return extractW2mPeople(source, searchTerm);
  }

  if (isMts) {
    const namedVoucherPages = isMsg
      ? (file.attachmentPages || []).filter((attachment) => /guest\s*voucher/i.test(attachment.name)).flatMap((attachment) => attachment.pages)
      : [];
    const sourcePages = isMsg
      ? namedVoucherPages.filter((page) => page.trim())
      : /guest\s*voucher/i.test(file.name)
        ? (file.visualPages?.length ? file.visualPages : file.pages).filter((page) => page.trim())
        : [];
    const compactQuery = normalize(searchTerm).replace(/\s+/g, "");
    const queryIsNumeric = /^\d{5,12}$/.test(compactQuery);
    const filenameMatchesBooking = queryIsNumeric
      && normalize(file.name).replace(/\s+/g, "").replace(/\.msg$|\.pdf$/i, "") === compactQuery;
    const hasBookingReference = (page: string) => {
      const references = Array.from(page.matchAll(
        /\b(?:booking|reservation|confirmation)\s*(?:number|no\.?|reference|ref\.?|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/gi,
      ), (match) => normalize(match[1]).replace(/\s+/g, ""));
      return references.includes(compactQuery);
    };
    let matchingPages = sourcePages.filter((page) => {
      if (!searchTerm.trim()) return true;
      if (queryIsNumeric) return hasBookingReference(page);
      return matchesSearchText(page, searchTerm) || arrivalNameMatchesText(searchTerm, page);
    });
    if (!matchingPages.length && filenameMatchesBooking) matchingPages = sourcePages;
    if (!matchingPages.length && isMsg && queryIsNumeric && hasBookingReference(file.pages[0] || "")) {
      matchingPages = sourcePages;
    }
    return matchingPages.flatMap((page) =>
      extractPeople(page, "", file.company, enableSunCheckInList, true),
    );
  }

  // FUN&SUN batch PDFs (Reservations (n), download.pdf, Hotel2Sejour.pdf)
  // contain many independent vouchers. Parse each page separately and keep
  // only the page containing the searched arrival guest. Parsing the joined
  // document makes extractPeople stop at the first "Agency Note" and can
  // therefore return the first booking's guests instead of the matching room.
  if (isFunSunIndexedFile(file)) {
    const sourcePages = isMsg
      ? (file.attachmentPages || []).filter((attachment) => /\.pdf$/i.test(attachment.name)).flatMap((attachment) => attachment.pages)
      : (file.visualPages?.length ? file.visualPages : file.pages);
    const matchingPages = sourcePages.filter((page) => {
      if (!searchTerm.trim()) return true;
      return arrivalNameMatchesText(searchTerm, page) || matchesSearchText(page, searchTerm);
    });
    return matchingPages.flatMap((page) =>
      extractPeople(page, "", file.company, enableSunCheckInList),
    );
  }

  if (isSun) {
    const sourcePages = isMsg
      ? file.pages.slice(1).filter((page) => page.trim())
      : (file.visualPages?.length ? file.visualPages : file.pages).filter((page) => page.trim());
    const filename = (file.name || file.path || "").split(/[\\/]/).pop() || "";
    const compactQuery = normalize(searchTerm).replace(/\s+/g, "");
    const numericFilename = /^\d+\.pdf$/i.test(filename);
    const queryIsNumeric = /^\d{5,12}$/.test(compactQuery);
    const filenameIsExactBooking = numericFilename
      && filename.replace(/\.pdf$/i, "") === compactQuery;
    const matchingPages = sourcePages.filter((page) => {
      if (!searchTerm.trim()) return true;
      if (filenameIsExactBooking) return true;
      return matchesSearchText(page, searchTerm) || arrivalNameMatchesText(searchTerm, page);
    });
    const pagePeople = matchingPages.flatMap((page) =>
      extractPeople(page, searchTerm, file.company, true),
    );
    if (pagePeople.length) return pagePeople;

    // A numeric single-voucher PDF is itself the booking identity, even when
    // the reservation number is printed only in the filename.
    if (filenameIsExactBooking && queryIsNumeric) {
      return sourcePages.flatMap((page) => extractPeople(page, searchTerm, file.company, true));
    }

    if (isMsg) {
      const emailBody = file.pages[0] || file.content || "";
      return extractPeople(emailBody, searchTerm, file.company, true);
    }
    return [];
  }

  if (!isMsg) {
    const source = /alltour/i.test(file.company)
      ? file.pages.join("\n\n--- ALLTOUR PAGE BREAK ---\n\n")
      : file.pages.join("\n\n");
    return extractPeople(source || file.content || "", searchTerm, file.company, enableSunCheckInList);
  }

  const emailBody = file.pages[0] || file.content || "";
  const fromEmail = extractPeople(emailBody, searchTerm, file.company, enableSunCheckInList);
  if (fromEmail.length) return fromEmail;

  const attachmentPages = file.pages.slice(1).filter((page) => page.trim());
  if (!attachmentPages.length) return [];

  const attachmentText = /alltour/i.test(file.company)
    ? attachmentPages.join("\n\n--- ALLTOUR PAGE BREAK ---\n\n")
    : attachmentPages.join("\n\n");
  const fromAllAttachments = extractPeople(attachmentText, searchTerm, file.company, enableSunCheckInList);
  if (fromAllAttachments.length) return fromAllAttachments;

  // Last fallback: some voucher layouts are page-oriented and should not
  // accidentally combine rows from separate attachments/pages.
  return attachmentPages.flatMap((page) => extractPeople(page, searchTerm, file.company, enableSunCheckInList));
}

/**
 * Preserve the established extraction route used by Single View. The new
 * page-aware SUN resolver above is intentionally limited to Multiple View.
 */
function extractPeopleFromIndexedFile(
  file: Pick<IndexedFile, "extension" | "pages" | "content" | "company" | "name" | "path" | "attachmentPages">,
  searchTerm: string,
  enableSunCheckInList = false,
) {
  const isMsg = file.extension.toLowerCase() === "msg";
  if (isPlanetIndexedFile(file)) {
    const sourcePages = isMsg
      ? (file.attachmentPages || []).filter((attachment) => /\.pdf$/i.test(attachment.name)).flatMap((attachment) => attachment.pages)
      : file.pages;
    return extractPlanetPeople(sourcePages, searchTerm);
  }
  if (isMtsIndexedFile(file)) {
    const voucherPages = isMsg
      ? (file.attachmentPages || []).filter(isMtsVoucherAttachment).flatMap((attachment) => attachment.pages)
      : /guest\s*voucher/i.test(file.name) ? file.pages : [];
    if (!voucherPages.length) return [];
    const compactQuery = normalize(searchTerm).replace(/\s+/g, "");
    const queryIsBookingNumber = /^\d{5,12}$/.test(compactQuery);
    const bookingMatches = queryIsBookingNumber && (
      file.name.replace(/\.msg$|\.pdf$/i, "") === compactQuery
      || voucherPages.some((page) => getMtsVoucherReference(page) === compactQuery)
    );
    const matchingPages = voucherPages.filter((page) =>
      !searchTerm.trim() || bookingMatches || arrivalNameMatchesText(searchTerm, page)
      || matchesSearchText(page, searchTerm),
    );
    if (!matchingPages.length) return [];
    // A Guest Voucher List contains independent bookings on separate pages.
    // Scope extraction to matching page(s) to prevent guests from mixing.
    return matchingPages.flatMap((page) => extractPeople(page, "", file.company, enableSunCheckInList, true));
  }
  if (!isMsg) {
    const source = /alltour/i.test(file.company)
      ? file.pages.join("\n\n--- ALLTOUR PAGE BREAK ---\n\n")
      : file.pages.join("\n\n");
    return extractPeople(source || file.content || "", searchTerm, file.company, enableSunCheckInList);
  }

  const emailBody = file.pages[0] || file.content || "";
  const fromEmail = extractPeople(emailBody, searchTerm, file.company, enableSunCheckInList);
  if (fromEmail.length) return fromEmail;

  const attachmentPages = file.pages.slice(1).filter((page) => page.trim());
  if (!attachmentPages.length) return [];

  const attachmentText = /alltour/i.test(file.company)
    ? attachmentPages.join("\n\n--- ALLTOUR PAGE BREAK ---\n\n")
    : attachmentPages.join("\n\n");
  const fromAllAttachments = extractPeople(attachmentText, searchTerm, file.company, enableSunCheckInList);
  if (fromAllAttachments.length) return fromAllAttachments;

  return attachmentPages.flatMap((page) => extractPeople(page, searchTerm, file.company, enableSunCheckInList));
}


type MultipleGuest = { name: string; dob: string };
type MultipleCard = {
  key: string;
  term: string;
  arrival: ArrivalRecord | null;
  file: IndexedFile | null;
  voucherFile?: IndexedFile | null;
  voucherPageNumber?: number;
  people: MultipleGuest[];
};

function getMtsVoucherReference(text: string) {
  // MTS/OTS uses numeric voucher references and alphanumeric booking references.
  const patterns = [
    /\b(?:voucher\s+reference|booking\s+reference|reservation\s+reference|confirmation\s+reference|booking|reservation|confirmation|voucher\s+ref|reference|ref)\s*(?:number|no\.?|#|id|code)?\s*[:#-]\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1].toUpperCase().replace(/[^A-Z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
      if (value.length >= 5) return value;
    }
  }
  return "";
}

function getMtsIndexedText(file: IndexedFile) {
  return [
    file.name, file.path, file.content, ...file.pages,
    ...(file.attachmentPages || []).flatMap((attachment) => [attachment.name, ...attachment.pages]),
  ].join("\n");
}

function isMtsVoucherAttachment(attachment: { name: string; pages: string[] }) {
  return /guest\s*voucher/i.test(attachment.name)
    || attachment.pages.some((page) => /\bVoucher\s+Reference\s+No\.?\s*:/i.test(page)
      && /\bTravellers\s*:/i.test(page));
}

function getMtsVoucherCandidates(files: IndexedFile[]) {
  return files.filter(isMtsIndexedFile).flatMap((file) => {
    const candidates: { file: IndexedFile; pages: string[]; pageNumbers: number[] }[] = [];
    if (file.extension.toLowerCase() === "msg") {
      for (const attachment of file.attachmentPages || []) {
        if (isMtsVoucherAttachment(attachment)) {
          const indexedPages = attachment.pages
            .map((page, index) => ({ page, pageNumber: index + 1 }))
            .filter((entry) => entry.page.trim());
          candidates.push({ file, pages: indexedPages.map((entry) => entry.page), pageNumbers: indexedPages.map((entry) => entry.pageNumber) });
        }
      }
    } else if (file.extension.toLowerCase() === "pdf" && /guest\s*voucher/i.test(file.name)) {
      const sourcePages = file.visualPages?.length ? file.visualPages : file.pages;
      const indexedPages = sourcePages
        .map((page, index) => ({ page, pageNumber: index + 1 }))
        .filter((entry) => entry.page.trim());
      candidates.push({
        file,
        pages: indexedPages.map((entry) => entry.page),
        pageNumbers: indexedPages.map((entry) => entry.pageNumber),
      });
    }
    return candidates;
  });
}

function buildMultipleCards(searchQuery: string, files: IndexedFile[], arrivals: ArrivalRecord[]): MultipleCard[] {
  const inputTerms = searchQuery.split(/[，,;؛\n]+/).map((part) => part.trim()).filter(Boolean);
  // A confirmation number can belong to multiple rooms. Expand it into
  // separate room searches so each guest is resolved against their own arrival.
  const terms = inputTerms.flatMap((term) => {
    const compact = normalize(term).replace(/\s+/g, "");
    const sameConfirmation = arrivals.filter((item) =>
      normalize(item.confirmationNo).replace(/\s+/g, "") === compact,
    );
    return sameConfirmation.length > 1 ? sameConfirmation.map((item) => item.roomNo) : [term];
  });
  const mtsFiles = files.filter(isMtsIndexedFile);
  // Booking emails can have numeric or alphanumeric names (e.g. SG-179412.msg).
  // Exclude the multi-booking Guest Voucher List message itself.
  const mtsMessages = mtsFiles.filter((file) =>
    file.extension.toLowerCase() === "msg" && !/guest\s*voucher/i.test(file.name),
  );
  const voucherCandidates = getMtsVoucherCandidates(files);
  const searchableText = new Map(files.map((file) => [file.id, getMtsIndexedText(file)]));

  return terms.flatMap<MultipleCard>((term, index) => {
    const compact = normalize(term).replace(/\s+/g, "");

    // Company searches return every booking file in the supplier folder.
    const companyQuery = getMultipleCompanyQuery(term);
    if (companyQuery) {
      const companyFiles = files.filter((candidate) =>
        isCompanyFolderMatch(candidate.company, companyQuery, files),
      );
      return companyFiles.map((companyFile, fileIndex) => ({
        key: index + "-" + compact + "-" + fileIndex + "-" + companyFile.id,
        term,
        arrival: null,
        file: companyFile,
        people: extractPeopleForMultipleView(companyFile, "", true),
      }));
    }

    const arrival = arrivals.find((item) =>
      normalize(item.roomNo).replace(/\s+/g, "") === compact
      || normalize(item.confirmationNo).replace(/\s+/g, "") === compact
      || (/[a-z\p{L}]/iu.test(term) && normalize(item.name).includes(normalize(term)))
    ) || null;
    const targetName = arrival?.name || term;
    const queryIsBookingNumber = /^\d{5,12}$/.test(compact);
    let file: IndexedFile | null = null;
    let voucherFile: IndexedFile | null = null;
    let voucherPageNumber: number | undefined;
    let people: MultipleGuest[] = [];

    // MTS priority: first find the exact numeric example.msg by matching
    // the arrival-report guest name. Only if no numeric MSG matches do we
    // search Guest Voucher PDFs / PDFs embedded in Outlook messages.
    const matchedMessage = !queryIsBookingNumber
      ? mtsMessages.find((candidate) =>
          arrivalNameMatchesText(targetName, searchableText.get(candidate.id) || ""),
        )
      : mtsMessages.find((candidate) =>
          candidate.name.replace(/\.msg$/i, "") === compact,
        );

    if (matchedMessage) {
      file = matchedMessage;

      // The arrival guest's numeric MSG is the primary booking identity.
      // Once found, locate the matching page in the separate Guest Voucher
      // List or in this MSG's embedded PDF to extract all travellers.
      const matchingVoucherPage = voucherCandidates.map((candidate) => {
        const matchedIndex = candidate.pages.findIndex((page) =>
          queryIsBookingNumber
            ? getMtsVoucherReference(page).replace(/-/g, "") === compact
            : arrivalNameMatchesText(targetName, page),
        );
        return {
          ...candidate,
          matchedPage: matchedIndex >= 0 ? candidate.pages[matchedIndex] : undefined,
          matchedPageNumber: matchedIndex >= 0 ? candidate.pageNumbers[matchedIndex] : undefined,
        };
      }).find((candidate) => Boolean(candidate.matchedPage));

      if (matchingVoucherPage?.matchedPage) {
        voucherFile = matchingVoucherPage.file;
        voucherPageNumber = matchingVoucherPage.matchedPageNumber;
        people = extractPeople(matchingVoucherPage.matchedPage, "", matchingVoucherPage.file.company, true, true);
      } else {
        const attachedVoucher = (matchedMessage.attachmentPages || []).find(isMtsVoucherAttachment);
        const matchedPageIndex = attachedVoucher?.pages.findIndex((page) =>
          queryIsBookingNumber
            ? getMtsVoucherReference(page).replace(/-/g, "") === compact
            : arrivalNameMatchesText(targetName, page),
        ) ?? -1;
        const matchedPage = matchedPageIndex >= 0 ? attachedVoucher?.pages[matchedPageIndex] : undefined;
        if (matchedPage) {
          voucherFile = matchedMessage;
          voucherPageNumber = matchedPageIndex + 1;
          people = extractPeople(matchedPage, "", matchedMessage.company, true, true);
        }
      }
    } else {
      const matchedVoucher = voucherCandidates.map((candidate) => {
        const matchedIndex = candidate.pages.findIndex((page) => queryIsBookingNumber
          ? getMtsVoucherReference(page).replace(/-/g, "") === compact
          : arrivalNameMatchesText(targetName, page));
        return {
          ...candidate,
          matchedPage: matchedIndex >= 0 ? candidate.pages[matchedIndex] : undefined,
          matchedPageNumber: matchedIndex >= 0 ? candidate.pageNumbers[matchedIndex] : undefined,
        };
      }).find((candidate) => Boolean(candidate.matchedPage));

      if (matchedVoucher?.matchedPage) {
        voucherFile = matchedVoucher.file;
        voucherPageNumber = matchedVoucher.matchedPageNumber;
        people = extractPeople(matchedVoucher.matchedPage, "", matchedVoucher.file.company, true, true);

        // Resolve the exact booking MSG from the voucher reference, whether
        // numeric (616310.msg) or alphanumeric (SG-179412.msg).
        const reference = getMtsVoucherReference(matchedVoucher.matchedPage).toLowerCase();
        const sameFolder = (candidate: IndexedFile) =>
          candidate.path.replace(/[\\/][^\\/]+$/, "").toLowerCase()
          === matchedVoucher.file.path.replace(/[\\/][^\\/]+$/, "").toLowerCase();
        const referenceMessage = reference
          ? mtsMessages.find((candidate) =>
              candidate.name.replace(/\.msg$/i, "").toLowerCase() === reference && sameFolder(candidate),
            ) || mtsMessages.find((candidate) =>
              candidate.name.replace(/\.msg$/i, "").toLowerCase() === reference,
            )
          : undefined;
        file = referenceMessage || matchedVoucher.file;
      }
    }

    // Preserve the existing SUN and other supplier search routes.
    const hasMtsNameMatch = mtsFiles.some((candidate) =>
      arrival
        ? arrivalNameMatchesText(targetName, searchableText.get(candidate.id) || "")
        : matchesSearchText(searchableText.get(candidate.id) || "", term),
    );
    if (!file && !hasMtsNameMatch) {
      const matchingFiles = files.filter((candidate) => {
        if (isMtsIndexedFile(candidate)) return false;
        const text = searchableText.get(candidate.id) || "";
        return arrival ? arrivalNameMatchesText(targetName, text) : matchesSearchText(text, term);
      });
      // Use the supplier explicitly printed in arr.pdf before considering
      // same-name hits from other operators (e.g. Biblio rooming-list emails).
      const companyScopedFiles = arrival?.company
        ? matchingFiles.filter((candidate) =>
            isCompanyFolderMatch(candidate.company, arrival.company || "", files),
          )
        : [];
      const sourceFiles = companyScopedFiles.length ? companyScopedFiles : matchingFiles;
      const funSunFiles = sourceFiles.filter(isFunSunIndexedFile);
      const prioritizedFunSunFiles = [...funSunFiles].sort((left, right) =>
        getFunSunFilePriority(left) - getFunSunFilePriority(right),
      );
      const sunFiles = sourceFiles.filter(isSunInternationalIndexedFile);
      const prioritizedSunFiles = [...sunFiles].sort((left, right) => {
        const priority = (candidate: IndexedFile) => {
          if (candidate.extension !== "pdf") return candidate.extension === "msg" ? 4 : 5;
          const filename = candidate.name.split(/[\\/]/).pop() || candidate.name;
          if (/^hotel2sejour\.pdf$/i.test(filename)) return 0;
          if (/^final\.pdf$/i.test(filename)) return 1;
          if (/^reservations\s*\(\s*\d+\s*\)\.pdf$/i.test(filename)) return 2;
          if (/^\d+\.pdf$/i.test(filename)) return 3;
          if (/\bHOTEL\s+C\/IN\s+LIST\b/i.test(candidate.content + " " + candidate.pages.join(" "))) return 4;
          return 5;
        };
        return priority(left) - priority(right);
      });
      file = prioritizedFunSunFiles[0] || prioritizedSunFiles[0] || sourceFiles[0] || null;
      if (file) {
        // When the booking number is the exact MSG/PDF filename, it identifies
        // the document itself. Do not pass that numeric code as a guest-name
        // filter; extract the complete guest list from the matched booking.
        const fileCode = file.name.replace(/\.(?:msg|pdf)$/i, "").toLowerCase();
        const queryIdentifiesFilename = fileCode === compact.toLowerCase();
        people = extractPeopleForMultipleView(file, queryIdentifiesFilename ? "" : targetName, true);
      }
    }

    // A booking code can point to a separate file for each reservation.
    // Return all exact code hits instead of silently selecting the first one.
    const isAlphanumericReference = !arrival && /^[a-z0-9-]{5,}$/i.test(compact);
    if (isAlphanumericReference && (!file || !isMtsIndexedFile(file))) {
      const referenceFiles = files.filter((candidate) =>
        !isMtsIndexedFile(candidate) && matchesSearchText(getMtsIndexedText(candidate), term),
      );
      if (referenceFiles.length) {
        return referenceFiles.map((referenceFile, fileIndex) => {
          const referenceCode = referenceFile.name.replace(/\.(?:msg|pdf)$/i, "").toLowerCase();
          const queryIdentifiesFilename = referenceCode === compact.toLowerCase();
          const extracted = extractPeopleForMultipleView(referenceFile, queryIdentifiesFilename ? "" : term, true);
          const unique = isW2mIndexedFile(referenceFile) || isSunInternationalIndexedFile(referenceFile)
            ? extracted
            : extracted.filter((person, personIndex, all) =>
                all.findIndex((candidate) => normalize(candidate.name) === normalize(person.name)
                  && normalize(candidate.dob) === normalize(person.dob)) === personIndex);
          return {
            key: index + "-" + compact + "-" + fileIndex + "-" + referenceFile.id,
            term, arrival: null, file: referenceFile, people: unique,
          };
        });
      }
    }

    const uniquePeople = file && (isMtsIndexedFile(file) || isSunInternationalIndexedFile(file) || isW2mIndexedFile(file))
      ? people
      : people.filter((person, personIndex, all) =>
          all.findIndex((candidate) => normalize(candidate.name) === normalize(person.name)
            && normalize(candidate.dob) === normalize(person.dob)) === personIndex);
    return [{ key: index + "-" + compact, term, arrival, file, voucherFile, voucherPageNumber, people: uniquePeople }];
  });
}

export default function GuestNameExtractorPage() {
  const { setFolderPath: saveSharedFolder, getFile: getSharedFile } = useFileLibrary();
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [query, setQuery] = useState("");
  const [multipleSearchQuery, setMultipleSearchQuery] = useState("");
  const [multipleDraftQuery, setMultipleDraftQuery] = useState("");
  const [multipleCardsData, setMultipleCardsData] = useState<MultipleCard[]>([]);
  const [multipleSearching, setMultipleSearching] = useState(false);
  const [viewMode, setViewMode] = useState<"single" | "multiple">("single");

  const [arrivalFrom, setArrivalFrom] = useState("");
  const [arrivalTo, setArrivalTo] = useState("");
  const [arrivalCompanyFilter, setArrivalCompanyFilter] = useState("all");
  const [multipleSort, setMultipleSort] = useState<"input" | "company" | "room">("input");
  const [multipleCopyStatus, setMultipleCopyStatus] = useState("");
  const [greenCards, setGreenCards] = useState<string[]>([]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("guest-extractor-green-cards-v1") || "[]");
      if (Array.isArray(saved)) setGreenCards(saved.filter((item): item is string => typeof item === "string"));
    } catch { /* ignore invalid saved card colors */ }
  }, []);

  useEffect(() => {
    try { localStorage.setItem("guest-extractor-green-cards-v1", JSON.stringify(greenCards)); }
    catch { /* ignore unavailable local storage */ }
  }, [greenCards]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [folderName, setFolderName] = useState("");
  const [nativeFolderPath, setNativeFolderPath] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [showCapitalizer, setShowCapitalizer] = useState(false);
  const [capitalizerText, setCapitalizerText] = useState("");
  const [capitalizerPosition, setCapitalizerPosition] = useState({ x: 24, y: 110 });
  const capitalizerDrag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  const [msgPreview, setMsgPreview] = useState<MsgPreviewData | null>(null);
  const [msgPreviewError, setMsgPreviewError] = useState("");
  const [autoOpenMtsVoucher, setAutoOpenMtsVoucher] = useState(false);
  const [mtsPrintRequest, setMtsPrintRequest] = useState<{ item: IndexedFile; pageInput: string } | null>(null);
  const [anexPrintRequest, setAnexPrintRequest] = useState<{ item: IndexedFile; pageInput: string } | null>(null);
  const [activeAttachment, setActiveAttachment] = useState<MsgAttachmentPreview | null>(null);
  const [attachmentSearchQuery, setAttachmentSearchQuery] = useState("");
  const [attachmentSearchMatches, setAttachmentSearchMatches] = useState<AttachmentSearchMatch[]>([]);
  const [attachmentSearchStatus, setAttachmentSearchStatus] = useState("");
  const [activeAttachmentPage, setActiveAttachmentPage] = useState(1);
  const [attachmentPdfSearchTerm, setAttachmentPdfSearchTerm] = useState("");
  useEffect(() => () => { msgPreview?.attachments.forEach((attachment) => URL.revokeObjectURL(attachment.url)); }, [msgPreview]);

  useEffect(() => {
    if (!autoOpenMtsVoucher || !selected || !isMtsIndexedFile(selected) || !msgPreview) return;
    const voucher = msgPreview.attachments.find((attachment) => /guest\s*voucher/i.test(attachment.name) && (attachment.type === "application/pdf" || attachment.name.toLowerCase().endsWith(".pdf")));
    setAutoOpenMtsVoucher(false);
    if (voucher) {
      setActiveAttachment(voucher);
      setActiveAttachmentPage(1);
      setAttachmentSearchMatches([]);
      setAttachmentSearchStatus("");
      setAttachmentPdfSearchTerm("");
    } else {
      setMsgPreviewError("تم فتح رسالة MTS، لكن لم يتم العثور على ملف PDF مرفق بها.");
    }
  }, [autoOpenMtsVoucher, selected, msgPreview]);
  const [currentPage, setCurrentPage] = useState(1);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const [storageMessage, setStorageMessage] = useState("جارٍ استعادة المجلد المحفوظ...");
  const [arrivals, setArrivals] = useState<ArrivalRecord[]>([]);
  const [arrivalReportName, setArrivalReportName] = useState("");
  const [arrivalStatus, setArrivalStatus] = useState("");
  const [arrivalBusy, setArrivalBusy] = useState(false);
  const arrivalInputRef = useRef<HTMLInputElement>(null);
  const nativeScanInProgressRef = useRef(false);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setIsDesktop(Boolean(window.desktopBridge)); }, []);

  useEffect(() => {
    if (!isDesktop || !nativeFolderPath || !window.desktopBridge) return;
    // Folder watcher notifications must never trigger a full re-index.
    // Searching is always performed against the in-memory index loaded once
    // when the app opens. The user can explicitly refresh if files changed.
    const unsubscribe = window.desktopBridge.onFolderChanged(() => {
      setStorageMessage("تم رصد تغيير في مجلد الحجوزات. نتائج البحث الحالية تستخدم الفهرس المحمّل؛ اضغط «فحص التحديثات» فقط إذا أردت إعادة الفهرسة.");
    });
    return () => {
      unsubscribe();
      void window.desktopBridge?.unwatchFolder();
    };
  }, [isDesktop, nativeFolderPath]);

  useEffect(() => {
    let active = true;
    async function restoreSession() {
      try {
        const savedState = JSON.parse(localStorage.getItem(GUEST_STATE_KEY) || "{}");
        // Electron userData survives the random local server port on each launch.
        const savedNativePath = window.desktopBridge
          ? await window.desktopBridge.getSavedFolderPath().catch(() => localStorage.getItem(NATIVE_FOLDER_KEY) || "")
          : "";
        if (!active) return;
        const savedArrivals = JSON.parse(localStorage.getItem(ARRIVAL_REPORT_KEY) || "[]");
        if (Array.isArray(savedArrivals)) setArrivals(savedArrivals as ArrivalRecord[]);
        setFolderName(String(savedState.folderName || ""));
        setQuery(String(savedState.query || ""));
        setCurrentPage(Math.max(1, Number(savedState.currentPage) || 1));
        setNativeFolderPath(savedNativePath);
        setStorageMessage(savedNativePath
          ? "تم استعادة مسار مجلد الحجوزات. جارٍ قراءة الملفات الأصلية مباشرة..."
          : "اختر مجلد الحجوزات للبدء. لا يتم إنشاء قاعدة بيانات أو حفظ نسخ من الملفات.");
        if (savedNativePath && window.desktopBridge) void scanNativeFolder(savedNativePath);
      } catch {
        if (active) setStorageMessage("تعذرت استعادة مسار مجلد الحجوزات. اختر المجلد مرة أخرى.");
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

  const previewUrl = useMemo(() => selected
    ? URL.createObjectURL(new Blob([selected.file], { type: getPreviewMimeType(selected.extension) }))
    : "", [selected]);
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
    const isLturFallbackQuery = q.replace(/\s+/g, "") === "ltur"
      && !files.some((item) => normalizeCompanyKey(item.company) === "ltur");

    const matchedResults = files.flatMap((item) => {
      const matchedPages = item.pages.reduce<number[]>((acc, page, index) => {
        const searchable = [item.name, item.path, item.company, page].join(" ");
        const matchesLinkedGuest = matchingArrivalNames.some((name) => arrivalNameMatchesText(name, searchable));
        const matchesDirectQuery = !isArrivalNumberSearch && (
          matchesSearchText(searchable, query)
          || (isLturFallbackQuery && normalizeCompanyKey(item.company) === "tui")
        );
        if (matchesDirectQuery || matchesLinkedGuest) {
          acc.push(index + 1);
        }
        return acc;
      }, []);
      if (!isArrivalNumberSearch && matchesSearchText([item.name, item.path, item.company].join(" "), query) && !matchedPages.length) {
        matchedPages.push(1);
      }
      return matchedPages.length ? [{ ...item, matchedPages }] : [];
    });
    return matchedResults.filter((item) => {
      if (!isMtsIndexedFile(item)) return true;
      const folderPath = item.path.replace(/[\\/][^\\/]+$/, "").toLowerCase();
      const folderFiles = files.filter((candidate) => isMtsIndexedFile(candidate) && candidate.path.replace(/[\\/][^\\/]+$/, "").toLowerCase() === folderPath);
      const bookingMessages = folderFiles.filter((candidate) => candidate.extension.toLowerCase() === "msg" && /^\d+\.msg$/i.test(candidate.name));
      if (bookingMessages.length) return item.extension.toLowerCase() === "msg" && /^\d+\.msg$/i.test(item.name);
      return /guest\s*voucher/i.test(item.name) && ["pdf", "msg"].includes(item.extension.toLowerCase());
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

  // Resolve each arr.pdf booking to the company folder containing its guest name.
  // This lets the arrival-time filter work by company without changing arr.pdf parsing.
  const arrivalCompanies = useMemo(() => {
    const companyByConfirmation = new Map<string, string>();
    for (const arrival of arrivals) {
      const matchedFile = files.find((candidate) =>
        candidate.pages.some((page) =>
          arrivalNameMatchesText(arrival.name, [candidate.name, candidate.path, candidate.company, page].join(" ")),
        ),
      );
      companyByConfirmation.set(arrival.confirmationNo, arrival.company || matchedFile?.company || "غير محددة");
    }
    return companyByConfirmation;
  }, [arrivals, files]);

  const arrivalCompanyOptions = useMemo(
    () => Array.from(new Set(Array.from(arrivalCompanies.values()))).sort((a, b) => a.localeCompare(b, "ar")),
    [arrivalCompanies],
  );

  const arrivalTimeMatches = useMemo(() => {
    if (!arrivalFrom && !arrivalTo && arrivalCompanyFilter === "all") return [];
    return arrivals.filter((item) =>
      (!arrivalFrom || item.arrivalTime >= arrivalFrom)
      && (!arrivalTo || item.arrivalTime <= arrivalTo)
      && (arrivalCompanyFilter === "all" || arrivalCompanies.get(item.confirmationNo) === arrivalCompanyFilter),
    ).sort((x, y) => x.arrivalTime.localeCompare(y.arrivalTime));
  }, [arrivals, arrivalFrom, arrivalTo, arrivalCompanyFilter, arrivalCompanies]);

  const multipleCards = useMemo(() => multipleCardsData.filter((card) => {
    if (arrivalCompanyFilter === "all") return true;
    const arrivalCompany = card.arrival ? arrivalCompanies.get(card.arrival.confirmationNo) : "";
    const company = arrivalCompany && arrivalCompany !== "غير محددة" ? arrivalCompany : card.file?.company || "غير محددة";
    return company === arrivalCompanyFilter
      || Boolean(card.file && isCompanyFolderMatch(card.file.company, arrivalCompanyFilter, files));
  }).sort((left, right) => {
    if (multipleSort === "company") {
      const companyCompare = (left.file?.company || "غير محددة").localeCompare(right.file?.company || "غير محددة", "ar", { sensitivity: "base" });
      if (companyCompare) return companyCompare;
    }
    if (multipleSort === "room" || multipleSort === "company") {
      return (left.arrival?.roomNo || "").localeCompare(right.arrival?.roomNo || "", undefined, { numeric: true });
    }
    return 0;
  }), [multipleCardsData, multipleSort, arrivalCompanyFilter, arrivalCompanies, files]);

  async function runMultipleSearch() {
    const searchText = multipleDraftQuery.trim();
    if (!searchText || multipleSearching || busy) return;
    setMultipleSearching(true);
    setMultipleSearchQuery(searchText);
    setMultipleCardsData([]);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
    try {
      setMultipleCardsData(buildMultipleCards(searchText, files, arrivals));
    } finally {
      setMultipleSearching(false);
    }
  }

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
  // When the search is a room or confirmation number, use the linked guest name
  // as the parser query. Passing the numeric identifier to a voucher parser can
  // make it match an unrelated number in the page and return a stray row.
  const arrivalSearchQuery = useMemo(() => {
    const q = normalize(query).replace(/\s+/g, "");
    if (!q) return "";
    const linked = arrivals.filter((item) =>
      normalize(item.roomNo).replace(/\s+/g, "") === q
      || normalize(item.confirmationNo).replace(/\s+/g, "") === q
    );
    return linked.map((item) => item.name).filter(Boolean).join(" ");
  }, [arrivals, query]);

  const effectivePeopleQuery = arrivalSearchQuery || query;
  const extractedPeople = useMemo(
    () => selected ? extractPeopleFromIndexedFile(selected, effectivePeopleQuery) : [],
    [selected, effectivePeopleQuery],
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
    setMultipleDraftQuery(""); setMultipleSearchQuery(""); setMultipleCardsData([]);
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
          pages: extracted.pages, visualPages: extracted.visualPages, attachmentPages: extracted.attachmentPages, file });
      } catch (readError) {
        const reason = readError instanceof Error ? readError.message : String(readError);
        failed.push(`${path} — ${reason || "سبب غير معروف"}`);
      }
      setProgress({ done: index + 1, total: readable.length });
    }
    setStorageMessage(`تمت قراءة ${indexed.length.toLocaleString("en-US")} ملف لهذه الجلسة فقط. لا يتم حفظ الملفات أو إنشاء قاعدة بيانات.`);
    setFiles(indexed); setWarnings(failed); setBusy(false);
    if (!readable.length) setError("لم أجد ملفات مدعومة داخل المجلد. الملفات المدعومة: PDF وWord DOCX وOutlook MSG وTXT وCSV وXML.");
    else if (!indexed.length) setError("تعذرت قراءة الملفات المحددة. تحقق من سلامة الملفات ثم حاول مرة أخرى.");
  }


  async function chooseNativeFolder() {
    if (!window.desktopBridge) {
      inputRef.current?.click();
      return;
    }
    try {
      const selectedPath = await window.desktopBridge.selectFolder();
      if (selectedPath) await scanNativeFolder(selectedPath);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "تعذر الوصول إلى المجلد المحدد.");
    }
  }

  async function scanNativeFolder(rootPath: string) {
    if (!window.desktopBridge) return;
    // Ignore duplicate folder-change events while a full indexing pass is running.
    if (nativeScanInProgressRef.current) return;
    nativeScanInProgressRef.current = true;
    setBusy(true); setError(""); setWarnings([]); setFiles([]); setQuery(""); setSelected(null);
    setMultipleDraftQuery(""); setMultipleSearchQuery(""); setMultipleCardsData([]);
    setNativeFolderPath(rootPath);
    setFolderName(rootPath);
    localStorage.setItem(NATIVE_FOLDER_KEY, rootPath);
    setStorageMessage("جارٍ فهرسة الملفات مباشرة من مجلد Windows دون رفعها أو نسخها إلى ذاكرة المتصفح...");
    setProgress({ done: 0, total: 0 });
    const indexed: IndexedFile[] = [];
    const failed: string[] = [];
    try {
      const entries = await saveSharedFolder("reservations", rootPath);
      const watchEnabled = await window.desktopBridge.watchFolder(rootPath);
      setProgress({ done: 0, total: entries.length });
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const extension = entry.name.split(".").pop()?.toLowerCase() || "";
        try {
          const file = await getSharedFile("reservations", entry);
          const extracted = await extractText(file, extension);
          const folderMetadata = getNativeFolderMetadata(entry.relativePath);
          indexed.push({
            id: entry.path + "-" + entry.mtimeMs,
            name: entry.name,
            path: entry.path,
            ...folderMetadata,
            extension,
            size: entry.size,
            content: extracted.content,
            pages: extracted.pages,
            visualPages: extracted.visualPages,
            attachmentPages: extracted.attachmentPages,
            file,
          });
        } catch (readError) {
          const reason = readError instanceof Error ? readError.message : String(readError);
          failed.push(`${entry.relativePath} — ${reason || "سبب غير معروف"}`);
        }
        // Avoid thousands of React renders; update progress in small batches.
        if ((index + 1) % 10 === 0 || index === entries.length - 1) {
          setProgress({ done: index + 1, total: entries.length });
        }
        // Yield to Chromium so the window can paint and respond to user input.
        if ((index + 1) % 5 === 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
      }
      setFiles(indexed);
      setWarnings(failed);
      setStorageMessage(`تم فهرسة ${indexed.length.toLocaleString("en-US")} ملف من المجلد الأصلي مباشرة. ${watchEnabled ? "مراقبة التغييرات والإضافات الجديدة مفعّلة." : "تعذر تفعيل المراقبة التلقائية؛ استخدم زر فحص التحديثات عند إضافة ملفات."} لن يتم نسخ الملفات إلى ذاكرة المتصفح.`);
      if (!entries.length) setError("لم أجد ملفات مدعومة داخل المجلد المحدد.");
      else if (!indexed.length) setError("تعذرت قراءة الملفات. تحقق من صلاحيات المجلد أو سلامة الملفات.");
      else if (entries.length >= 20000) setError("تم الوصول إلى حد الفهرسة البالغ 20,000 ملف. اختر مجلداً فرعياً لتقليل نطاق البحث.");
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "تعذرت قراءة المجلد المحدد.");
      setStorageMessage("تعذرت فهرسة المجلد. تحقق من اتصال القرص أو صلاحيات الوصول.");
    } finally {
      nativeScanInProgressRef.current = false;
      setBusy(false);
    }
  }


  function openPreviewWithCapitalizer(item: SearchResult) {
    setShowCapitalizer(true);
    openPreview(item);
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

  async function openOriginalMsgInOutlook() {
    if (!selected || selected.extension.toLowerCase() !== "msg") return;
    // In the desktop app, open the original file path through Windows file associations.
    // This allows Outlook (if installed and associated with .msg) to open the real file.
    if (window.desktopBridge && (selected.path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(selected.path))) {
      try {
        const opened = await window.desktopBridge.openPath(selected.path);
        setStorageMessage(opened
          ? "تم إرسال ملف Outlook الأصلي إلى Windows لفتحه بالتطبيق المرتبط بملفات MSG."
          : "تعذر فتح الملف تلقائياً. تأكد من تثبيت Outlook وارتباط ملفات MSG به، أو استخدم زر تنزيل الملف الأصلي.");
      } catch {
        setStorageMessage("تعذر فتح ملف MSG في Outlook. استخدم زر تنزيل الملف الأصلي.");
      }
      return;
    }
    // Browser fallback: download the untouched message for opening in Outlook.
    downloadOriginalMsg();
    setStorageMessage("تم تنزيل ملف MSG الأصلي. افتحه باستخدام Outlook إذا كان مثبتاً على جهازك.");
  }

  async function openMtsOutlookFile(item: IndexedFile) {
    if (item.extension.toLowerCase() !== "msg") return;
    if (!window.desktopBridge) {
      const url = URL.createObjectURL(item.file);
      const link = document.createElement("a");
      link.href = url;
      link.download = item.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setStorageMessage("تم تنزيل ملف Outlook الأصلي. افتحه باستخدام Outlook.");
      return;
    }
    try {
      const opened = await window.desktopBridge.openPath(item.path);
      setStorageMessage(opened
        ? "تم إرسال ملف MTS الأصلي إلى Windows لفتحه باستخدام Outlook."
        : "تعذر فتح ملف MTS. تحقق من تثبيت Outlook وارتباط ملفات MSG به.");
    } catch {
      setStorageMessage("تعذر فتح ملف MTS في Outlook.");
    }
  }

  function openMtsVoucher(item: SearchResult) {
    setAutoOpenMtsVoucher(item.extension.toLowerCase() === "msg");
    openPreview(item);
  }

  function printMtsVoucher(item: IndexedFile, defaultPageNumber = 1) {
    setMtsPrintRequest({ item, pageInput: String(defaultPageNumber) });
  }

  function findAnexVoucherPage(item: IndexedFile, searchTerm: string, guestName = "") {
    const pages = item.visualPages?.length ? item.visualPages : item.pages;
    const compactQuery = normalize(searchTerm).replace(/\\s+/g, "");
    const isReservationNumber = /^\\d{7,8}$/.test(compactQuery);
    const nameTokens = normalize(guestName || searchTerm).split(/\\s+/).filter((token) => token.length > 1);
    const matchIndex = pages.findIndex((page) => {
      const normalizedPage = normalize(page);
      if (isReservationNumber && normalizedPage.replace(/\\s+/g, "").includes(compactQuery)) return true;
      return nameTokens.length >= 2 && nameTokens.every((token) => normalizedPage.includes(token));
    });
    return matchIndex >= 0 ? matchIndex + 1 : 1;
  }

  function findFunSunVoucherPage(item: IndexedFile, searchTerm: string, guestName = "") {
    const pages = item.visualPages?.length ? item.visualPages : item.pages;
    const compactQuery = normalize(searchTerm).replace(/\s+/g, "");
    const isBookingNumber = /^\d{3,9}$/.test(compactQuery);
    // Arrival reports can include punctuation and titles, e.g. "MIGULIN, Mr. KIRILL".
    // Ignore titles and compare individual normalized name tokens.
    const nameTokens = getSunSearchTokens(guestName || searchTerm);
    const matchIndex = pages.findIndex((page) => {
      const normalizedPage = normalize(page);
      if (isBookingNumber && normalizedPage.replace(/\s+/g, "").includes(compactQuery)) return true;
      const pageTokens = new Set(normalizedPage.split(/\s+/));
      return nameTokens.length >= 2 && arrivalNameMatchesText(guestName || searchTerm, page);
    });
    // Do not silently print page 1 when the guest could not be located.
    return matchIndex >= 0 ? matchIndex + 1 : 0;
  }

  async function executeFunSunVoucherPrint(item: IndexedFile, pageInput: string) {
    const pageNumber = Number(pageInput.trim());
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      window.alert("يرجى إدخال رقم صفحة صحيح يبدأ من 1.");
      return;
    }
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      window.alert("يرجى السماح بالنوافذ المنبثقة حتى تتمكن من طباعة فاوتشر FUN&SUN.");
      return;
    }
    printWindow.document.write("<!doctype html><html><body style='font-family:Arial;padding:24px'>جارٍ تجهيز صفحة FUN&SUN للطباعة...</body></html>");
    printWindow.document.close();
    try {
      if (item.extension.toLowerCase() !== "pdf") throw new Error("طباعة FUN&SUN المباشرة متاحة حالياً لملفات PDF الأصلية فقط.");
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await item.file.arrayBuffer()) }).promise;
      if (pageNumber > pdf.numPages) throw new Error("رقم الصفحة أكبر من عدد صفحات ملف FUN&SUN (" + pdf.numPages + ").");
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.8 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("تعذر تجهيز صفحة FUN&SUN للطباعة.");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: context, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
      const pageImage = canvas.toDataURL("image/png");
      printWindow.document.open();
      printWindow.document.write(`<!doctype html>
        <html lang="ar">
          <head>
            <meta charset="utf-8">
            <title>FUN&amp;SUN Voucher - Page ${pageNumber}</title>
            <style>
              @page { size: A4; margin: 0; }
              html, body { margin: 0; padding: 0; background: #fff; }
              img { display: block; width: 210mm; height: 297mm; object-fit: contain; margin: 0 auto; }
              @media screen { body { display:flex; justify-content:center; } img { max-width:100vw; height:auto; } }
            </style>
          </head>
          <body>
            <img src="${pageImage}" alt="FUN&amp;SUN Voucher page ${pageNumber}">
            <script>
              const image = document.querySelector("img");
              image.addEventListener("load", () => { window.focus(); window.print(); }, { once: true });
              image.addEventListener("error", () => { document.body.textContent = "تعذر تجهيز الصفحة للطباعة."; }, { once: true });
            </script>
          </body>
        </html>`);
      printWindow.document.close();
    } catch (error) {
      printWindow.close();
      window.alert(error instanceof Error ? error.message : "حدث خطأ أثناء تجهيز صفحة FUN&SUN للطباعة.");
    }
  }

  async function executeAnexVoucherPrint(item: IndexedFile, pageInput: string) {
    const pageNumber = Number(pageInput.trim());
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      window.alert("يرجى إدخال رقم صفحة صحيح يبدأ من 1.");
      return;
    }
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      window.alert("يرجى السماح بالنوافذ المنبثقة حتى تتمكن من طباعة الفاوتشر.");
      return;
    }
    printWindow.document.write("<!doctype html><html><body style='font-family:Arial;padding:24px'>جارٍ تجهيز فاوتشر Anex للطباعة...</body></html>");
    printWindow.document.close();
    try {
      if (item.extension.toLowerCase() !== "pdf") throw new Error("طباعة Anex المباشرة متاحة حالياً لملفات PDF الأصلية فقط.");
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await item.file.arrayBuffer()) }).promise;
      if (pageNumber > pdf.numPages) throw new Error("رقم الصفحة أكبر من عدد صفحات فاوتشر Anex (" + pdf.numPages + ").");
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.8 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("تعذر تجهيز صفحة فاوتشر Anex للطباعة.");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: context, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
      const pageImage = canvas.toDataURL("image/png");
      printWindow.document.open();
      printWindow.document.write(`<!doctype html>
        <html lang="ar">
          <head>
            <meta charset="utf-8">
            <title>Anex Voucher - Page ${pageNumber}</title>
            <style>
              @page { size: A4; margin: 0; }
              html, body { margin: 0; padding: 0; background: #fff; }
              img { display: block; width: 210mm; height: 297mm; object-fit: contain; margin: 0 auto; }
              @media screen { body { display:flex; justify-content:center; } img { max-width:100vw; height:auto; } }
            </style>
          </head>
          <body>
            <img src="${pageImage}" alt="Anex Voucher page ${pageNumber}">
            <script>
              const image = document.querySelector("img");
              image.addEventListener("load", () => { window.focus(); window.print(); }, { once: true });
              image.addEventListener("error", () => { document.body.textContent = "تعذر تجهيز الصفحة للطباعة."; }, { once: true });
            </script>
          </body>
        </html>`);
      printWindow.document.close();
      setAnexPrintRequest(null);
    } catch (error) {
      printWindow.close();
      window.alert(error instanceof Error ? error.message : "حدث خطأ أثناء تجهيز فاوتشر Anex للطباعة.");
    }
  }

  async function executeMtsVoucherPrint(item: IndexedFile, pageInput: string) {
    const pageNumber = Number(pageInput.trim());
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      window.alert("يرجى إدخال رقم صفحة صحيح يبدأ من 1.");
      return;
    }

    // Open synchronously from the click to avoid popup blocking during PDF preparation.
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      window.alert("يرجى السماح بالنوافذ المنبثقة حتى تتمكن من طباعة الفاوتشر.");
      return;
    }
    printWindow.document.write("<!doctype html><html><body style='font-family:Arial;padding:24px'>جارٍ تجهيز الصفحة المطلوبة للطباعة...</body></html>");
    printWindow.document.close();

    try {
      let voucherBlob: Blob | null = null;
      if (item.extension.toLowerCase() === "pdf") {
        voucherBlob = item.file;
      } else if (item.extension.toLowerCase() === "msg") {
        const { MsgReader } = await import("@kenjiuno/msgreader-web-ng");
        const reader = new MsgReader(await item.file.arrayBuffer());
        const data = reader.getFileData();
        const rows = Array.isArray(data.attachments) ? data.attachments as unknown as Array<Record<string, unknown>> : [];
        const msgReader = reader as unknown as {
          getAttachment: (attachment: unknown) => { fileName?: string; content: Uint8Array };
        };
        for (const row of rows) {
          const extracted = msgReader.getAttachment(row);
          const name = String(extracted.fileName || row.fileName || row.name || "");
          const declaredMime = String(row.attachMimeTag || "").split(";")[0].trim().toLowerCase();
          if (!/guest\s*voucher/i.test(name)) continue;
          if (!name.toLowerCase().endsWith(".pdf") && declaredMime !== "application/pdf") continue;
          voucherBlob = new Blob([new Uint8Array(extracted.content).buffer as ArrayBuffer], { type: "application/pdf" });
          break;
        }
      }
      if (!voucherBlob) throw new Error("لم يتم العثور على ملف PDF Voucher داخل حجز MTS.");

      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await voucherBlob.arrayBuffer()) }).promise;
      if (pageNumber > pdf.numPages) {
        throw new Error("رقم الصفحة أكبر من عدد صفحات الفاوتشر (" + pdf.numPages + ").");
      }

      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.8 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("تعذر تجهيز صفحة الفاوتشر للطباعة.");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: context, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
      const pageImage = canvas.toDataURL("image/png");

      printWindow.document.open();
      printWindow.document.write(`<!doctype html>
        <html lang="ar">
          <head>
            <meta charset="utf-8">
            <title>MTS Guest Voucher - Page ${pageNumber}</title>
            <style>
              @page { size: A4; margin: 0; }
              html, body { margin: 0; padding: 0; background: #fff; }
              img { display: block; width: 210mm; height: 297mm; object-fit: contain; margin: 0 auto; }
              @media screen { body { display:flex; justify-content:center; } img { max-width:100vw; height:auto; } }
            </style>
          </head>
          <body>
            <img src="${pageImage}" alt="MTS Guest Voucher page ${pageNumber}">
            <script>
              const image = document.querySelector("img");
              image.addEventListener("load", () => {
                window.focus();
                window.print();
              }, { once: true });
              image.addEventListener("error", () => {
                document.body.textContent = "تعذر تجهيز الصفحة للطباعة.";
              }, { once: true });
            </script>
          </body>
        </html>`);
      printWindow.document.close();
    } catch (error) {
      printWindow.close();
      window.alert(error instanceof Error ? error.message : "حدث خطأ أثناء تجهيز صفحة الفاوتشر للطباعة.");
    }
  }

  async function removeSavedFolder() {
    if (!window.confirm("هل تريد إلغاء ربط مجلد الحجوزات؟ لن يتم حذف الملفات الأصلية من جهازك.")) return;
    await window.desktopBridge?.unwatchFolder();
    await window.desktopBridge?.clearSavedFolderPath();
    setFiles([]);
    setQuery("");
    setSelected(null);
    setCurrentPage(1);
    setFolderName("");
    setNativeFolderPath("");
    localStorage.removeItem(NATIVE_FOLDER_KEY);
    localStorage.removeItem(GUEST_STATE_KEY);
    setWarnings([]);
    setStorageMessage("تم إلغاء ربط مجلد الحجوزات. الملفات الأصلية لم يتم تغييرها.");
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
    const value = /^\(Age:\s*\d+\)$/i.test(person.dob)
      ? person.name + " " + person.dob
      : [person.name, person.dob === "لم يُعثر عليه" ? "" : person.dob].filter(Boolean).join(" - ");
    try {
      await navigator.clipboard.writeText(value);
      setDiagnosticStatus(`تم نسخ بيانات ${person.name}.`);
    } catch {
      setDiagnosticStatus("تعذر النسخ. تأكد من السماح للمتصفح بالوصول إلى الحافظة.");
    }
  }

  const [diagnosticStatus, setDiagnosticStatus] = useState("");

  async function copyArrivalNumbers(kind: "room" | "confirmation") {
    const values = arrivals
      .map((item) => kind === "room" ? item.roomNo : item.confirmationNo)
      .filter(Boolean);
    if (!values.length) {
      setMultipleCopyStatus("لا توجد بيانات في arr.pdf لنسخها.");
      return;
    }
    try {
      await navigator.clipboard.writeText(values.join(", "));
      setMultipleCopyStatus(kind === "room"
        ? `تم نسخ ${values.length} رقم غرفة. يمكنك لصقها في البحث المتعدد.`
        : `تم نسخ ${values.length} رقم تأكيدي. يمكنك لصقها في البحث المتعدد.`);
    } catch {
      setMultipleCopyStatus("تعذر النسخ. تأكد من السماح للتطبيق بالوصول إلى الحافظة.");
    }
  }

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
      <header className="hero">
        <p className="eyebrow">Long Beach Resort · Hotel Tools</p>
        <h1>Guest Name Extractor</h1>
        <p>ابحث عن ملف الحجز برقم الحجز أو الرقم التأكيدي أو اسم النزيل أو الشركة، واستخرج أسماء جميع النزلاء وتواريخ ميلادهم تلقائياً.</p>
      </header>
      <section className="panel">
        <div className="section-heading">
          <div><h2>1. اختيار مجلد الحجوزات بالكامل</h2>
            <p className="muted">اربط مجلد الحجوزات الأصلي مرة واحدة. في نسخة Windows تتم قراءة الملفات مباشرة من مكانها دون رفعها أو نسخها إلى ذاكرة المتصفح.</p></div>
          <button type="button" className="add-button" onClick={() => void chooseNativeFolder()} disabled={busy}>
            {busy ? "جارٍ فحص المجلد..." : isDesktop ? (nativeFolderPath ? "تغيير مجلد الحجوزات" : "ربط مجلد Windows") : "اختيار مجلد"}
          </button>
          {isDesktop && nativeFolderPath && <button type="button" className="add-button" onClick={() => void scanNativeFolder(nativeFolderPath)} disabled={busy}>فحص التحديثات</button>}
          {files.length > 0 && <button type="button" className="add-button" onClick={() => void removeSavedFolder()} disabled={busy}>إلغاء ربط المجلد</button>}
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
        {folderName && <div className="filename" dir="ltr">المجلد المرتبط: {folderName}</div>}
        <p className="saved-hint" role="status">{storageMessage}</p>
        {arrivalReportName && <div className="filename">تقرير الوصول: {arrivalReportName} · {arrivals.length.toLocaleString("en-US")} حجز</div>}
        {arrivals.length > 0 && <div className="filename">بيانات الوصول المحفوظة: {arrivals.length.toLocaleString("en-US")} حجز</div>}
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
          <div className="section-heading" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>وضع العرض</h2>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="add-button" aria-pressed={viewMode === "single"} onClick={() => setViewMode("single")}
                style={viewMode === "single" ? { background: "#1769aa", color: "#fff" } : undefined}>Single View</button>
              <button type="button" className="add-button" aria-pressed={viewMode === "multiple"} onClick={() => setViewMode("multiple")}
                style={viewMode === "multiple" ? { background: "#1769aa", color: "#fff" } : undefined}>Multiple View</button>
            </div>
          </div>
          <h2>فلتر مواعيد الوصول من / إلى</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10 }}>
            <label style={{ display: "grid", gap: 5 }}>الشركة
              <select value={arrivalCompanyFilter} onChange={(event) => setArrivalCompanyFilter(event.target.value)}
                style={{ minHeight: 40, border: "1px solid #cbd6e2", borderRadius: 8, padding: 8, font: "inherit" }}>
                <option value="all">كل الشركات</option>
                {arrivalCompanyOptions.map((company) => <option key={company} value={company}>{company}</option>)}
              </select>
            </label>
            <label style={{ display: "grid", gap: 5 }}>من
              <input type="time" value={arrivalFrom} onChange={(event) => setArrivalFrom(event.target.value)}
                style={{ minHeight: 40, border: "1px solid #cbd6e2", borderRadius: 8, padding: 8 }} />
            </label>
            <label style={{ display: "grid", gap: 5 }}>إلى
              <input type="time" value={arrivalTo} onChange={(event) => setArrivalTo(event.target.value)}
                style={{ minHeight: 40, border: "1px solid #cbd6e2", borderRadius: 8, padding: 8 }} />
            </label>
          </div>
          {(arrivalFrom || arrivalTo || arrivalCompanyFilter !== "all") && <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
            الغرف المطابقة ({arrivalTimeMatches.length}): {arrivalTimeMatches.length
              ? arrivalTimeMatches.map((item) => item.roomNo + " (" + item.arrivalTime + ")").join("، ")
              : "لا توجد غرف مطابقة للفترة والشركة المحددتين"}
          </div>}
        </section>
        {viewMode === "multiple" && <section className="panel">
          <h2>البحث المتعدد</h2>
          <p className="muted">هذا البحث مستقل عن Single View. اكتب أرقام الغرف أو الأرقام التأكيدية أو أسماء النزلاء، وافصل بينها بفاصلة، ثم اضغط «بحث» لعرض النتائج.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "10px 0" }}>
            <button type="button" className="add-button" onClick={() => void runMultipleSearch()} disabled={!multipleDraftQuery.trim() || busy || multipleSearching}>
              {multipleSearching ? <><span className="search-spinner" aria-hidden="true" /> جارٍ البحث...</> : "بحث"}
            </button>
            <button type="button" className="add-button" onClick={() => { setMultipleDraftQuery(""); setMultipleSearchQuery(""); setMultipleCardsData([]); }} disabled={!multipleDraftQuery && !multipleSearchQuery && !multipleCardsData.length}>مسح البحث</button>
            <button type="button" className="add-button" onClick={() => void copyArrivalNumbers("room")} disabled={!arrivals.length}>نسخ كل أرقام الغرف</button>
            <button type="button" className="add-button" onClick={() => void copyArrivalNumbers("confirmation")} disabled={!arrivals.length}>نسخ كل الأرقام التأكيدية</button>
          </div>
          {multipleCopyStatus && <p className="saved-hint" role="status">{multipleCopyStatus}</p>}
          {multipleSearching && <p className="saved-hint" role="status">جارٍ مطابقة الأسماء مع ملفات Guest Voucher وملفات الحجز...</p>}
          <textarea value={multipleDraftQuery} onChange={(event) => setMultipleDraftQuery(event.target.value)}
             placeholder="مثال: 0115, 209682, Fazliji, 0166" aria-label="البحث في عدة غرف وحجوزات"
            rows={3} style={{ width: "100%", border: "1px solid #cbd6e2", borderRadius: 10, padding: 12, font: "inherit", resize: "vertical" }} />
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
            <label htmlFor="multiple-sort" style={{ fontSize: 13, color: "#526174" }}>ترتيب الغرف:</label>
            <select id="multiple-sort" value={multipleSort} onChange={(event) => setMultipleSort(event.target.value as "input" | "company" | "room")}
              style={{ minHeight: 38, border: "1px solid #cbd6e2", borderRadius: 8, padding: "4px 10px", font: "inherit" }}>
              <option value="input">حسب ترتيب البحث</option>
              <option value="company">حسب الشركة ثم رقم الغرفة</option>
              <option value="room">حسب رقم الغرفة</option>
            </select>
          </div>
          {multipleSearchQuery.trim() && <p className="saved-hint">عدد مربعات البحث بعد الفلترة: {multipleCards.length}</p>}
          {multipleSearchQuery.trim() && multipleCards.length === 0 && <p className="empty-exclusions">لا توجد مربعات مطابقة للشركة المحددة أو لم يتم العثور على نتائج.</p>}
          {multipleSearching && <p className="saved-hint" role="status">جارٍ مطابقة الأسماء مع ملفات Guest Voucher وملفات الحجز...</p>}
          {multipleCards.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,390px),1fr))", gap: 12, marginTop: 14 }}>
            {multipleCards.map((card) => {
              const isGreen = greenCards.includes(card.key);
              return <article key={card.key} className="folder-result" style={{
                minWidth: 0, background: isGreen ? "#e8f5e9" : undefined,
                border: isGreen ? "1px solid #81c784" : undefined
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{card.arrival?.name || card.file?.name || card.term}</strong>
                  <button type="button" className="add-button" onClick={() => setGreenCards((current) =>
                    current.includes(card.key) ? current.filter((key) => key !== card.key) : [...current, card.key]
                  )}>{isGreen ? "اللون الافتراضي" : "تمييز بالأخضر"}</button>
                </div>
                {card.arrival
                  ? <p className="muted">رقم الغرفة: {card.arrival.roomNo} · الرقم التأكيدي: {card.arrival.confirmationNo} · موعد الوصول: {card.arrival.arrivalTime}{card.arrival.company ? ` · الشركة: ${card.arrival.company}` : ""}</p>
                  : <p className="muted">بحث: {card.term} · لم يتم العثور على سجل مطابق في arr.pdf</p>}
                {card.file ? <>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
                    {isMtsIndexedFile(card.file) ? <>
                      {card.file.extension.toLowerCase() === "msg" && <button type="button" className="add-button" onClick={() => void openMtsOutlookFile(card.file!)}>فتح ملف Outlook</button>}
                      <button type="button" className="add-button" onClick={() => openMtsVoucher({ ...(card.voucherFile || card.file)!, matchedPages: [1] })}>استعراض الفاوتشر</button>
                      <button type="button" className="add-button" onClick={() => void printMtsVoucher((card.voucherFile || card.file)!, card.voucherPageNumber || 1)}>طباعة الفاوتشر</button>
                    </> : isFunSunIndexedFile(card.file) && card.file.extension.toLowerCase() === "pdf" ? <>
                      <button type="button" className="add-button" onClick={() => {
                        const pageNumber = findFunSunVoucherPage(card.file!, card.term, card.arrival?.name || "");
                        if (!pageNumber) {
                          window.alert("لم أتمكن من تحديد صفحة النزيل بالاسم داخل هذا الملف. لن تتم طباعة الصفحة الأولى تلقائياً حتى لا تُطبع صفحة خاطئة.");
                          return;
                        }
                        void executeFunSunVoucherPrint(card.file!, String(pageNumber));
                      }}>طباعة</button>
                      <button type="button" className="add-button" onClick={() => {
                        const pageNumber = findFunSunVoucherPage(card.file!, card.term, card.arrival?.name || "");
                        if (!pageNumber) {
                          window.alert("لم أتمكن من تحديد صفحة النزيل بالاسم داخل هذا الملف.");
                          return;
                        }
                        openPreview({ ...card.file!, matchedPages: [pageNumber] });
                      }}>معاينة صفحة الفاوتشر</button>
                    </> : isAnexIndexedFile(card.file) && card.file.extension.toLowerCase() === "pdf" ? <>
                      <button type="button" className="add-button" onClick={() => void executeAnexVoucherPrint(card.file!, String(findAnexVoucherPage(card.file!, card.term, card.arrival?.name || "")))}>طباعة</button>
                      <button type="button" className="add-button" onClick={() => openPreview({ ...card.file!, matchedPages: [findAnexVoucherPage(card.file!, card.term, card.arrival?.name || "")] })}>معاينة صفحة الفاوتشر</button>
                    </> : <>
                      {isDesktop && <button type="button" className="add-button" onClick={() => void window.desktopBridge?.showInFolder(card.file!.path)}>مكان الملف</button>}
                      <button type="button" className="add-button" onClick={() => openPreviewWithCapitalizer({ ...card.file!, matchedPages: [1] })}>معاينة واستخراج</button>
                    </>}
                  </div>
                  <p className="folder-path" dir="ltr">{card.file.path}</p>
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "rgba(255,255,255,.72)", border: "1px solid #dbe4ef" }}>
                    <strong style={{ display: "block", marginBottom: 7 }}>الأسماء المستخرجة تلقائياً: {card.people.length}</strong>
                    {card.people.length
                      ? <div dir="ltr" style={{ display: "grid", gap: 5, textAlign: "left" }}>
                          {card.people.map((person, personIndex) => <span key={person.name + personIndex} style={{ fontSize: 13 }}>{person.name}{/^\(Age:\s*\d+\)$/i.test(person.dob) ? " " + person.dob : person.dob ? " - " + person.dob : isSunInternationalIndexedFile(card.file) ? " -" : ""}</span>)}
                        </div>
                      : <span className="muted">لم يتم استخراج أسماء من الملف تلقائياً.</span>}
                  </div>
                </> : <p className="empty-exclusions">لم يتم العثور على ملف حجز مطابق لهذا البحث.</p>}
              </article>;
            })}
          </div>}
        </section>}
        {viewMode === "single" && <>
        <section className="panel">
          <h2>2. البحث بالاسم أو الشركة أو رقم الحجز أو رقم الغرفة أو الرقم التأكيدي</h2>
          <p className="muted">بعد رفع تقرير arr.pdf يمكنك البحث برقم الغرفة أو الرقم التأكيدي؛ سيظهر اسم النزيل وميعاد وصوله والملفات التي تحتوي على اسمه.</p>
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="اكتب الاسم أو الشركة أو رقم الحجز أو رقم الغرفة أو الرقم التأكيدي..." aria-label="البحث بالاسم أو الشركة أو رقم الحجز أو رقم الغرفة أو الرقم التأكيدي"
            style={{ width: "100%", minHeight: 50, border: "1px solid #cbd6e2", borderRadius: 10, padding: "10px 14px", font: "inherit" }} />
          <div className="folder-stats">
            <div><strong>{files.length}</strong><span>ملف تمت قراءته</span></div>
            <div><strong>{companies}</strong><span>شركة/مجلد شركة</span></div>
            <div><strong>{formatSize(totalSize)}</strong><span>إجمالي حجم الملفات</span></div>
          </div>
          {query.trim() && <p className="saved-hint">عدد الملفات المطابقة: {results.length} · حجوزات تقرير الوصول المطابقة: {arrivalMatches.length}</p>}
          {query.trim() && arrivalMatches.length > 0 && <div className="folder-results" style={{ marginTop: 14 }}>
            {arrivalMatches.map((item) => <article className="folder-result" key={item.confirmationNo}>
              <strong>{item.name}</strong>
              <p className="muted">رقم الغرفة: {item.roomNo} · الرقم التأكيدي: {item.confirmationNo} · موعد الوصول: {item.arrivalTime}</p>
            </article>)}
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
              </div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {isAnexIndexedFile(item) && item.extension.toLowerCase() === "pdf" ? <button type="button" className="add-button" onClick={() => void executeAnexVoucherPrint(item, String(findAnexVoucherPage(item, effectivePeopleQuery)))}>طباعة</button> : isDesktop && <button type="button" className="add-button" onClick={() => void window.desktopBridge?.showInFolder(item.path)}>مكان الملف</button>}
                <button type="button" className="add-button" onClick={() => openPreviewWithCapitalizer(item)}>معاينة واستخراج</button>
              </div></div>
              <p className="folder-path" dir="ltr">{item.path}</p>
              {(() => {
                // Preview extracted guests for every company using the same
                // company-specific parser used by the document preview.
                const guests = extractPeopleFromIndexedFile(item, effectivePeopleQuery);
                const uniqueGuests = isW2mIndexedFile(item) || isSunInternationalIndexedFile(item)
                  ? guests
                  : guests.filter((person, index, all) =>
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
                        <span key={index} style={{ fontSize: 13, textAlign: "left" }}>{person.name}{/^\(Age:\s*\d+\)$/i.test(person.dob) ? " " + person.dob : person.dob ? " - " + person.dob : ""}</span>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </article>
          ))}</div> : <p className="empty-exclusions">لا توجد ملفات تحتوي على كلمة البحث.</p>}
        </section>}
        </>}
      </>}

      {selected && <section className="panel" aria-label="الأسماء وتواريخ الميلاد في الصفحة الحالية">
        <div style={{ marginTop: 18 }}>
          <h3>الأسماء وتواريخ الميلاد في الصفحة الحالية</h3>
          {extractedPeople.length ? <div className="folder-results">{extractedPeople.map((person, index) => (
            <div className="folder-result" key={index} dir="ltr" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, textAlign: "left", fontWeight: 700 }}>
              <span>{selected.company.toLocaleLowerCase() === "easy jet" || !person.dob || person.dob === "لم يُعثر عليه" ? person.name : /^\(Age:\s*\d+\)$/i.test(person.dob) || selected.company.toLocaleLowerCase() === "pegas" ? (person.name + " " + person.dob) : (person.name + " - " + person.dob)}</span>
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
              ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"].includes(selected.extension) ? (
                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 420, maxHeight: "75vh", overflow: "auto", padding: 16, background: "#e9edf2" }}>
                  <img src={previewUrl} alt={selected.name} style={{ display: "block", maxWidth: "100%", maxHeight: "72vh", objectFit: "contain", background: "white", boxShadow: "0 2px 12px rgba(0,0,0,.12)" }} />
                </div>
              ) : <pre style={{ whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 600, padding: 18, direction: "rtl", background: "white" }}>{pageText || "لا يوجد نص قابل للعرض."}</pre>}
          </div>
        )}
          {diagnosticStatus && <p className="saved-hint" role="status">{diagnosticStatus}</p>}
          <p className="saved-hint">تنبيه: قد تتضمن البيانات المنسوخة أسماء النزلاء وأرقام جوازات السفر؛ راجعها واحذف أي بيانات لا ترغب في مشاركتها قبل إرسالها.</p>
      </section>}

      {anexPrintRequest && <div role="dialog" aria-modal="true" aria-labelledby="anex-print-title"
        style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(15,23,42,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <section className="panel" style={{ width: "min(100%, 440px)", margin: 0, boxShadow: "0 20px 60px rgba(0,0,0,.25)" }}>
          <h2 id="anex-print-title" style={{ marginTop: 0 }}>طباعة فاوتشر Anex</h2>
          <p className="muted">تم تحديد صفحة الحجز تلقائياً. يمكنك تعديل رقم الصفحة قبل الطباعة.</p>
          <label htmlFor="anex-print-page" style={{ display: "grid", gap: 6 }}>رقم الصفحة
            <input id="anex-print-page" type="number" min="1" step="1" autoFocus
              value={anexPrintRequest.pageInput}
              onChange={(event) => setAnexPrintRequest((current) => current ? { ...current, pageInput: event.target.value } : null)}
              onKeyDown={(event) => { if (event.key === "Enter") void executeAnexVoucherPrint(anexPrintRequest.item, anexPrintRequest.pageInput); }}
              style={{ minHeight: 42, border: "1px solid #cbd6e2", borderRadius: 8, padding: "8px 12px", font: "inherit" }} />
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button type="button" className="add-button" onClick={() => setAnexPrintRequest(null)}>إلغاء</button>
            <button type="button" className="add-button" onClick={() => void executeAnexVoucherPrint(anexPrintRequest.item, anexPrintRequest.pageInput)}>متابعة الطباعة</button>
          </div>
        </section>
      </div>}
      {mtsPrintRequest && <div role="dialog" aria-modal="true" aria-labelledby="mts-print-title"
        style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(15,23,42,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <section className="panel" style={{ width: "min(100%, 440px)", margin: 0, boxShadow: "0 20px 60px rgba(0,0,0,.25)" }}>
          <h2 id="mts-print-title" style={{ marginTop: 0 }}>اختيار صفحة الفاوتشر للطباعة</h2>
          <p className="muted">أدخل رقم الصفحة المطابقة للحجز من Guest Voucher. يمكنك تعديل الرقم المقترح.</p>
          <label htmlFor="mts-print-page" style={{ display: "grid", gap: 6 }}>رقم الصفحة
            <input id="mts-print-page" type="number" min="1" step="1" autoFocus
              value={mtsPrintRequest.pageInput}
              onChange={(event) => setMtsPrintRequest((current) => current ? { ...current, pageInput: event.target.value } : null)}
              onKeyDown={(event) => { if (event.key === "Enter") void executeMtsVoucherPrint(mtsPrintRequest.item, mtsPrintRequest.pageInput); }}
              style={{ minHeight: 42, border: "1px solid #cbd6e2", borderRadius: 8, padding: "8px 12px", font: "inherit" }} />
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button type="button" className="add-button" onClick={() => setMtsPrintRequest(null)}>إلغاء</button>
            <button type="button" className="add-button" onClick={() => void executeMtsVoucherPrint(mtsPrintRequest.item, mtsPrintRequest.pageInput)}>متابعة الطباعة</button>
          </div>
        </section>
      </div>}


      {showCapitalizer && <aside role="dialog" aria-label="تحويل أول حرف من كل كلمة إلى حرف كبير"
        style={{ position: "fixed", left: capitalizerPosition.x, top: capitalizerPosition.y, zIndex: 1200,
          width: "min(360px, calc(100vw - 24px))", padding: 12, border: "1px solid #9aaabd",
          borderRadius: 12, background: "#fff", color: "#1e293b", boxShadow: "0 12px 36px rgba(15,23,42,.25)" }}>
        <div onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          const rect = event.currentTarget.parentElement!.getBoundingClientRect();
          capitalizerDrag.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={(event) => {
          const drag = capitalizerDrag.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setCapitalizerPosition({
            x: Math.max(0, Math.min(window.innerWidth - 80, event.clientX - drag.offsetX)),
            y: Math.max(0, Math.min(window.innerHeight - 80, event.clientY - drag.offsetY)),
          });
        }} onPointerUp={() => { capitalizerDrag.current = null; }}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10,
            cursor: "move", userSelect: "none", touchAction: "none", fontWeight: 700 }}>
          <span>Capitalize First Letter</span>
          <button type="button" aria-label="إغلاق أداة تحويل الأحرف" onClick={() => setShowCapitalizer(false)}
            style={{ border: 0, borderRadius: 6, background: "#eef2f7", padding: "4px 9px", cursor: "pointer" }}>×</button>
        </div>
        <textarea value={capitalizerText} onChange={(event) => setCapitalizerText(event.target.value)}
          placeholder="اكتب أو الصق النص هنا..."
          aria-label="النص المراد تحويله"
          rows={3} style={{ display: "block", width: "100%", boxSizing: "border-box", resize: "vertical",
            border: "1px solid #cbd5e1", borderRadius: 8, padding: 9, font: "inherit" }} dir="auto" />
        <div style={{ marginTop: 8, padding: 9, minHeight: 38, maxHeight: 120, overflow: "auto",
          borderRadius: 8, background: "#f1f5f9", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} dir="auto">
          {capitalizerText.replace(/[\p{L}\p{N}]+/gu, (word) => word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase())}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 7, marginTop: 9 }}>
          <button type="button" className="add-button" onClick={() => setCapitalizerText("")}>مسح</button>
          <button type="button" className="add-button" onClick={() => {
            const converted = capitalizerText.replace(/[\p{L}\p{N}]+/gu, (word) => word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase());
            void navigator.clipboard?.writeText(converted);
          }}>نسخ النتيجة</button>
        </div>
      </aside>}

      {warnings.length > 0 && <section className="panel"><h2>ملفات تعذرت قراءتها</h2>
        <ul className="steps">{warnings.map((path) => <li key={path} dir="ltr">{path}</li>)}</ul></section>}
      <p className="foot"><a href="/" style={{ color: "#1769aa" }}>العودة إلى أدوات الفندق</a></p>
    </div>
  );
}