import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";

export const runtime = "nodejs";
export const maxDuration = 30;

type XmlValue = string | number | XmlObject | XmlValue[] | null | undefined;
type XmlObject = { [key: string]: XmlValue };

const ALLOWED_CODES = new Set([
  "1010", "1012", "1014", "1019", "1020", "1025",
  "4500", "4501", "5001", "5003", "5005", "5008", "5009", "5086",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "G_FIRST" || name === "G_TRX_CHAR_DATE",
});

function textValue(value: XmlValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.length ? textValue(value[0]) : "";
  const object = value as XmlObject;
  return object["#text"] == null ? "" : textValue(object["#text"]);
}

function descendants(node: XmlValue, key: string): XmlValue[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((item) => descendants(item, key));
  const found: XmlValue[] = [];
  for (const [name, value] of Object.entries(node as XmlObject)) {
    if (name === key) {
      if (Array.isArray(value)) found.push(...value);
      else if (value != null) found.push(value);
    } else {
      found.push(...descendants(value, key));
    }
  }
  return found;
}

function findTransactionGroups(node: XmlValue, groups: { code: string; description: string; records: XmlValue[] }[] = []) {
  if (node == null || typeof node !== "object") return groups;
  if (Array.isArray(node)) {
    for (const item of node) findTransactionGroups(item, groups);
    return groups;
  }

  const record = node as XmlObject;
  if (record.FIRST !== undefined && record.LIST_SECOND !== undefined) {
    const label = textValue(record.FIRST);
    const match = label.match(/^\s*(\d{4})\s*(.*)$/);
    if (match && ALLOWED_CODES.has(match[1])) {
      groups.push({
        code: match[1],
        description: match[2].trim(),
        records: descendants(record.LIST_SECOND, "G_TRX_CHAR_DATE"),
      });
    }
  }

  for (const value of Object.values(record)) findTransactionGroups(value, groups);
  return groups;
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "من فضلك ارفع ملف Journal by Cashier and Transaction Code بصيغة XML." }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".xml")) {
      return NextResponse.json({ error: "الملف يجب أن يكون بصيغة XML." }, { status: 400 });
    }
    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "حجم الملف يجب ألا يتجاوز 20 ميجابايت." }, { status: 413 });
    }

    let root: XmlValue;
    try {
      root = parser.parse(await file.text());
    } catch {
      return NextResponse.json({ error: "تعذر قراءة ملف XML. تأكد أن التقرير سليم." }, { status: 400 });
    }

    const groups = findTransactionGroups(root);
    const rows = groups.flatMap((group) => group.records.map((item) => {
      const row = item && typeof item === "object" && !Array.isArray(item) ? item as XmlObject : {};
      return {
        code: group.code,
        description: textValue(row.TRX_DESC) || group.description,
        room: textValue(row.ROOM),
        guestName: textValue(row.GUEST_FULL_NAME),
        debit: textValue(row.CASHIER_DEBIT) || "0",
        credit: textValue(row.CASHIER_CREDIT) || "0",
        date: textValue(row.BUSINESS_FORMAT_DATE),
        time: textValue(row.BUSINESS_TIME),
      };
    })).filter((row) => /^\d+$/.test(row.room) && (row.guestName || Number(row.debit) !== 0 || Number(row.credit) !== 0));

    if (!groups.length) {
      return NextResponse.json({ error: "لم يتم العثور على أي كود من الأكواد المحددة داخل التقرير." }, { status: 404 });
    }

    const summary = [...new Set(rows.map((row) => row.code))].sort().map((code) => ({
      code,
      description: rows.find((row) => row.code === code)?.description || "",
      count: rows.filter((row) => row.code === code).length,
    }));

    return NextResponse.json({
      rows,
      summary,
      count: rows.length,
      codesFound: summary.length,
      allowedCodes: [...ALLOWED_CODES],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "حدث خطأ أثناء استخراج بيانات التقرير.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
