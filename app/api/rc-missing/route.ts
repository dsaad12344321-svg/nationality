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

function normalizeRoom(value: unknown): string {
  const room = String(value ?? "").trim();
  return /^\d{3,4}$/.test(room) ? room.padStart(4, "0") : "";
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const resFile = form.get("resFile");
    const rawPdfRooms = form.get("pdfRooms");
    const rawPdfFiles = form.get("pdfFiles");

    if (!(resFile instanceof File) || typeof rawPdfRooms !== "string" || typeof rawPdfFiles !== "string") {
      return NextResponse.json({ error: "من فضلك ارفع تقرير RES_DETAIL.xml واختر ملف ZIP يحتوي على ملفات PDF." }, { status: 400 });
    }
    if (!resFile.name.toLowerCase().endsWith(".xml")) {
      return NextResponse.json({ error: "تقرير الوصول يجب أن يكون بصيغة XML." }, { status: 400 });
    }
    if (resFile.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "حجم تقرير RES_DETAIL يجب ألا يتجاوز 20 ميجابايت." }, { status: 413 });
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

    let suppliedRooms: unknown;
    try {
      suppliedRooms = JSON.parse(rawPdfRooms);
    } catch {
      return NextResponse.json({ error: "تعذر قراءة قائمة الغرف المستخرجة من ZIP." }, { status: 400 });
    }
    if (!Array.isArray(suppliedRooms)) {
      return NextResponse.json({ error: "قائمة غرف ملفات PDF غير صالحة." }, { status: 400 });
    }

    const pdfRooms = new Set(suppliedRooms.map(normalizeRoom).filter(Boolean));
    const pdfFiles = Number(rawPdfFiles);
    if (!Number.isInteger(pdfFiles) || pdfFiles < 0) {
      return NextResponse.json({ error: "عدد ملفات PDF غير صالح." }, { status: 400 });
    }

    const missingRooms = reportRooms.filter((room) => !pdfRooms.has(room));
    const matchedRooms = reportRooms.length - missingRooms.length;

    return NextResponse.json({
      totalRooms: reportRooms.length,
      matchedRooms,
      missingCount: missingRooms.length,
      pdfFiles,
      pdfRoomsCount: pdfRooms.size,
      missingRooms,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "حدث خطأ أثناء فحص RC Missing.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
