import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";

export const runtime = "nodejs";
export const maxDuration = 30;

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

type XmlNode = string | number | boolean | null | undefined | XmlNode[] | { [key: string]: XmlNode };

function findRoomRows(node: XmlNode, rows: { room: string; towel: string }[] = []) {
  if (Array.isArray(node)) {
    for (const item of node) findRoomRows(item, rows);
    return rows;
  }
  if (!node || typeof node !== "object") return rows;

  const record = node as Record<string, XmlNode>;
  if (Object.prototype.hasOwnProperty.call(record, "C18") &&
      Object.prototype.hasOwnProperty.call(record, "C48")) {
    const room = String(record.C18 ?? "").trim();
    const towel = String(record.C48 ?? "").trim();
    if (/^\d+$/.test(room)) rows.push({ room, towel });
  }

  for (const value of Object.values(record)) findRoomRows(value, rows);
  return rows;
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "من فضلك ارفع ملف التقرير بصيغة XML." }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".xml")) {
      return NextResponse.json({ error: "الملف يجب أن يكون بصيغة XML." }, { status: 400 });
    }
    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "حجم الملف يجب ألا يتجاوز 20 ميجابايت." }, { status: 413 });
    }

    const xml = await file.text();
    let parsed: XmlNode;
    try {
      parsed = parser.parse(xml) as XmlNode;
    } catch {
      return NextResponse.json({ error: "تعذر قراءة ملف XML. تأكد أن الملف صالح." }, { status: 400 });
    }

    const rows = findRoomRows(parsed);
    if (!rows.length) {
      return NextResponse.json({ error: "لم يتم العثور على سجلات الغرف أو الحقلين C18 وC48 في الملف." }, { status: 400 });
    }

    const rooms = [...new Set(
      rows.filter((row) => row.towel === "").map((row) => row.room.padStart(4, "0"))
    )].sort((a, b) => Number(a) - Number(b));

    return NextResponse.json({ rooms, count: rooms.length, scannedRows: rows.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "حدث خطأ أثناء فحص ملف التقرير.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
