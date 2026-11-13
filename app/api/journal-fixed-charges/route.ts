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
  isArray: (name) => name === "G_RESERVATION" || name === "G_FIXED_CHARGES",
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

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "من فضلك ارفع تقرير RES_DETAIL بصيغة XML." }, { status: 400 });
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

    const reservations = collect(root, "G_RESERVATION");
    if (!reservations.length) {
      return NextResponse.json({ error: "لم يتم العثور على سجلات الوصول G_RESERVATION. تأكد أنك رفعت تقرير RES_DETAIL." }, { status: 404 });
    }

    const rows = reservations.flatMap((reservation) => {
      const room = textValue(reservation.ROOM_NO) || textValue(reservation.DISP_ROOM_NO);
      const guestName = textValue(reservation.FULL_NAME) || textValue(reservation.FULL_NAME_NO_SHR_IND);
      const charges = collect(reservation.LIST_G_FIXED_CHARGES, "G_FIXED_CHARGES");
      return charges.filter((charge) => textValue(charge.FC_TRX_CODE) === "1012").map((charge) => ({
        room,
        guestName: guestName.replace(/^\*/, "").replace(/,(Mr\.|Mrs\.|Ms\.|Miss\.)$/i, ""),
        code: textValue(charge.FC_TRX_CODE),
        description: textValue(charge.FC_DESCRIPTION),
        price: textValue(charge.FC_PRICE),
        quantity: textValue(charge.FC_QUANTITY),
        frequency: textValue(charge.FC_FREQUENCY),
        beginDate: textValue(charge.FC_BEGIN_DATE),
        endDate: textValue(charge.FC_END_DATE),
      }));
    }).filter((row) => /^\d+$/.test(row.room));

    const rooms = [...new Set(rows.map((row) => row.room))].sort((a, b) => Number(a) - Number(b));
    return NextResponse.json({ rows, count: rows.length, rooms, roomCount: rooms.length, reservationsScanned: reservations.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "حدث خطأ أثناء فحص تقرير الوصول.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
