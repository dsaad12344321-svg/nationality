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
type TowelRow = { room: string; towel: string; adults: string; children: string };

function findRoomRows(node: XmlNode, rows: TowelRow[] = []) {
  if (Array.isArray(node)) {
    for (const item of node) findRoomRows(item, rows);
    return rows;
  }
  if (!node || typeof node !== "object") return rows;

  const record = node as Record<string, XmlNode>;
  if (Object.prototype.hasOwnProperty.call(record, "C18") &&
      Object.prototype.hasOwnProperty.call(record, "C42") &&
      Object.prototype.hasOwnProperty.call(record, "C45") &&
      Object.prototype.hasOwnProperty.call(record, "C48")) {
    const room = String(record.C18 ?? "").trim();
    if (/^\d+$/.test(room)) {
      rows.push({
        room,
        adults: String(record.C42 ?? "").trim(),
        children: String(record.C45 ?? "").trim(),
        towel: String(record.C48 ?? "").trim(),
      });
    }
  }

  for (const value of Object.values(record)) findRoomRows(value, rows);
  return rows;
}

function findCompanyRooms(node: XmlNode, rooms: Set<string>, excludedCompanies: Set<string>) {
  if (Array.isArray(node)) {
    for (const item of node) findCompanyRooms(item, rooms, excludedCompanies);
    return;
  }
  if (!node || typeof node !== "object") return;

  const record = node as Record<string, XmlNode>;
  if (Object.prototype.hasOwnProperty.call(record, "ROOM") &&
      Object.prototype.hasOwnProperty.call(record, "COMPANY_NAME")) {
    const room = String(record.ROOM ?? "").trim();
    const company = String(record.COMPANY_NAME ?? "").trim();
    if (/^\d+$/.test(room) && /house\s*use/i.test(company)) {
      rooms.add(room.padStart(4, "0"));
      excludedCompanies.add(company);
    }
  }

  for (const value of Object.values(record)) findCompanyRooms(value, rooms, excludedCompanies);
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const inhFile = form.get("inhFile");
    const mode = String(form.get("mode") || "missing");
    if (!(file instanceof File) || !(inhFile instanceof File)) {
      return NextResponse.json({ error: "من فضلك ارفع ملف تقرير المناشف وملف Guests INH - By Room." }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".xml") || !inhFile.name.toLowerCase().endsWith(".xml")) {
      return NextResponse.json({ error: "يجب أن يكون الملفان بصيغة XML." }, { status: 400 });
    }
    if (file.size > 20 * 1024 * 1024 || inhFile.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "يجب ألا يتجاوز حجم كل ملف 20 ميجابايت." }, { status: 413 });
    }

    const xml = await file.text();
    const inhXml = await inhFile.text();
    let parsed: XmlNode;
    try {
      parsed = parser.parse(xml) as XmlNode;
    } catch {
      return NextResponse.json({ error: "تعذر قراءة ملف XML. تأكد أن الملف صالح." }, { status: 400 });
    }

    const rows = findRoomRows(parsed);
    if (!rows.length) {
      return NextResponse.json({ error: "لم يتم العثور على سجلات الغرف أو الحقول C18 وC42 وC45 وC48 في الملف." }, { status: 400 });
    }

    let inhParsed: XmlNode;
    try {
      inhParsed = parser.parse(inhXml) as XmlNode;
    } catch {
      return NextResponse.json({ error: "تعذر قراءة ملف Guests INH - By Room. تأكد أن الملف صالح." }, { status: 400 });
    }

    const houseUseRooms = new Set<string>();
    const excludedCompanies = new Set<string>();
    findCompanyRooms(inhParsed, houseUseRooms, excludedCompanies);

    if (mode === "consistency") {
      const mismatches = rows
        .filter((row) => {
          const room = row.room.padStart(4, "0");
          if (houseUseRooms.has(room) || row.towel === "") return false;
          if (!/^\d+$/.test(row.adults) || !/^\d+$/.test(row.children) || !/^\d+$/.test(row.towel)) return false;
          return Number(row.adults) + Number(row.children) !== Number(row.towel);
        })
        .map((row) => ({
          room: row.room.padStart(4, "0"),
          adults: Number(row.adults),
          children: Number(row.children),
          expectedTowels: Number(row.adults) + Number(row.children),
          actualTowels: Number(row.towel),
        }))
        .sort((a, b) => Number(a.room) - Number(b.room));

      return NextResponse.json({
        mismatches,
        count: mismatches.length,
        scannedRows: rows.length,
        excludedCount: rows.filter((row) => houseUseRooms.has(row.room.padStart(4, "0"))).length,
        excludedRooms: [...new Set(rows.filter((row) => houseUseRooms.has(row.room.padStart(4, "0"))).map((row) => row.room.padStart(4, "0")))].sort((a, b) => Number(a) - Number(b)),
        excludedCompanies: [...excludedCompanies],
      });
    }

    const missingRooms = [...new Set(
      rows.filter((row) => row.towel === "").map((row) => row.room.padStart(4, "0"))
    )].sort((a, b) => Number(a) - Number(b));
    const excludedRooms = missingRooms.filter((room) => houseUseRooms.has(room));
    const rooms = missingRooms.filter((room) => !houseUseRooms.has(room));

    return NextResponse.json({
      rooms,
      count: rooms.length,
      scannedRows: rows.length,
      excludedCount: excludedRooms.length,
      excludedRooms,
      excludedCompanies: [...excludedCompanies],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "حدث خطأ أثناء فحص ملف التقرير.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
