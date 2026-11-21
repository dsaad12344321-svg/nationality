import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";

export const runtime = "nodejs";
export const maxDuration = 30;

type XmlValue = string | number | XmlObject | XmlValue[] | null | undefined;
type XmlObject = { [key: string]: XmlValue };

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "G_RESERVATION",
});

function textValue(value: XmlValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.length ? textValue(value[0]) : "";
  const object = value as XmlObject;
  return object["#text"] == null ? "" : textValue(object["#text"]);
}

function collect(node: XmlValue, key: string): XmlObject[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((item) => collect(item, key));
  const object = node as XmlObject;
  const found: XmlObject[] = [];
  for (const [name, value] of Object.entries(object)) {
    if (name === key) {
      const items = Array.isArray(value) ? value : value == null ? [] : [value];
      found.push(...items.filter((item): item is XmlObject => !!item && typeof item === "object" && !Array.isArray(item)));
    } else {
      found.push(...collect(value, key));
    }
  }
  return found;
}

function normalizeRoom(value: string): string {
  const room = value.trim();
  return /^\d{3,4}$/.test(room) ? room.padStart(4, "0") : "";
}

/** Reads only ZIP central-directory filenames; PDF contents are not extracted or uploaded anywhere. */
function getZipPdfNames(bytes: Buffer): string[] {
  const minOffset = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ملف ZIP غير صالح أو لا يحتوي على فهرس ملفات قابل للقراءة.");

  const entryCount = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const names: string[] = [];

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("تعذر قراءة قائمة الملفات داخل ZIP. تأكد أن الملف غير تالف.");
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const start = offset + 46;
    const end = start + nameLength;
    if (end > bytes.length) throw new Error("قائمة الملفات داخل ZIP غير مكتملة.");
    const nameBytes = bytes.subarray(start, end);
    const name = (flags & 0x0800) ? nameBytes.toString("utf8") : nameBytes.toString("utf8");
    if (/\.pdf$/i.test(name) && !name.endsWith("/")) names.push(name);
    offset = end + extraLength + commentLength;
  }
  return names;
}

function roomsFromPdfName(name: string): string[] {
  const base = name.split(/[\\/]/).pop() || name;
  const withoutExtension = base.replace(/\.pdf$/i, "");
  const matches = withoutExtension.match(/(?<!\d)\d{3,4}(?!\d)/g) || [];
  return matches.map(normalizeRoom).filter(Boolean);
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const resFile = form.get("resFile");
    const zipFile = form.get("zipFile");

    if (!(resFile instanceof File) || !(zipFile instanceof File)) {
      return NextResponse.json({ error: "من فضلك ارفع تقرير RES_DETAIL.xml وملف ZIP الذي يحتوي على ملفات PDF." }, { status: 400 });
    }
    if (!resFile.name.toLowerCase().endsWith(".xml")) {
      return NextResponse.json({ error: "تقرير الوصول يجب أن يكون بصيغة XML." }, { status: 400 });
    }
    if (!zipFile.name.toLowerCase().endsWith(".zip")) {
      return NextResponse.json({ error: "يجب رفع مجموعة ملفات PDF داخل ملف ZIP." }, { status: 400 });
    }
    if (resFile.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "حجم تقرير RES_DETAIL يجب ألا يتجاوز 20 ميجابايت." }, { status: 413 });
    }
    if (zipFile.size > 50 * 1024 * 1024) {
      return NextResponse.json({ error: "حجم ملف ZIP يجب ألا يتجاوز 50 ميجابايت." }, { status: 413 });
    }

    let root: XmlValue;
    try {
      root = parser.parse(await resFile.text());
    } catch {
      return NextResponse.json({ error: "تعذر قراءة RES_DETAIL.xml. تأكد أن التقرير سليم." }, { status: 400 });
    }

    const reservations = collect(root, "G_RESERVATION");
    if (!reservations.length) {
      return NextResponse.json({ error: "لم يتم العثور على سجلات G_RESERVATION. تأكد أنك رفعت تقرير RES_DETAIL المستخدم في Journal Detector." }, { status: 404 });
    }

    const reportRooms = [...new Set(reservations.map((reservation) =>
      normalizeRoom(textValue(reservation.ROOM_NO) || textValue(reservation.DISP_ROOM_NO))
    ).filter(Boolean))].sort((a, b) => Number(a) - Number(b));

    if (!reportRooms.length) {
      return NextResponse.json({ error: "تمت قراءة التقرير، لكن لم يتم العثور على أرقام غرف مكونة من 3 أو 4 خانات." }, { status: 404 });
    }

    let pdfNames: string[];
    try {
      pdfNames = getZipPdfNames(Buffer.from(await zipFile.arrayBuffer()));
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "تعذر قراءة ملف ZIP." }, { status: 400 });
    }

    if (!pdfNames.length) {
      return NextResponse.json({ error: "لم يتم العثور على ملفات PDF داخل ملف ZIP." }, { status: 404 });
    }

    const pdfRooms = new Set(pdfNames.flatMap(roomsFromPdfName));
    const missingRooms = reportRooms.filter((room) => !pdfRooms.has(room));
    const matchedRooms = reportRooms.length - missingRooms.length;

    return NextResponse.json({
      totalRooms: reportRooms.length,
      matchedRooms,
      missingCount: missingRooms.length,
      pdfFiles: pdfNames.length,
      pdfRoomsCount: pdfRooms.size,
      missingRooms,
      pdfRooms: [...pdfRooms].sort((a, b) => Number(a) - Number(b)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "حدث خطأ أثناء فحص RC Missing.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
