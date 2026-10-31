import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
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
  isArray: (name) => ["G_COUNTRY_CODE", "G_MASTER_VALUE", "G_HEADING_1_ORDER", "G_SUM_AMOUNT"].includes(name),
});

const ALIASES: Record<string, string> = {
  egypt: "egyptian",
  "united states": "american", "united states of america": "american", usa: "american", "u.s.a.": "american",
  "great britain": "british", "united kingdom": "british", uk: "british", england: "british", britain: "british",
  germany: "german", ukraine: "ukrainian", russia: "russian", belgium: "belgian", poland: "polish",
  china: "chinese", "people's republic of china": "chinese", france: "french", italy: "italian", india: "indian",
  japan: "japanese", croatia: "croatian", pakistan: "pakistani", spain: "spanish", iran: "iranian",
  "islamic republic of iran": "iranian", israel: "israeli", "state of israel": "israeli",
  "saudi arabia": "saudi", iraq: "iraqi", libya: "libyan", sudan: "sudanese", palestine: "palestinian",
  "state of palestine": "palestinian", jordan: "jordanian", morocco: "moroccan", algeria: "algerian",
  tunisia: "tunisian", mauritania: "mauritanian", bahrain: "bahraini", lebanon: "lebanese", lebanese: "lebanese",
  "united arab emirates": "arab", uae: "arab", kuwait: "arab", qatar: "arab", oman: "arab",
  yemen: "arab", syria: "arab", lebanon: "arab", comoros: "arab", somalia: "arab", djibouti: "arab",
  "arab israeli": "arab_israeli", "israeli arab": "arab_israeli", "arab-israeli": "arab_israeli",
};

const DETAILS: [string, string][] = [
  ["أمريكي", "american"], ["إنجليزي", "british"], ["ألماني", "german"], ["أوكراني", "ukrainian"],
  ["روسي", "russian"], ["بلجيكي", "belgian"], ["بولندي", "polish"], ["صيني", "chinese"],
  ["فرنسي", "french"], ["إيطالي", "italian"], ["هندي", "indian"], ["ياباني", "japanese"],
  ["كرواتي", "croatian"], ["باكستاني", "pakistani"], ["إسباني", "spanish"], ["إيراني", "iranian"],
  ["إسرائيلي", "israeli"], ["عرب إسرائيلي", "arab_israeli"], ["سعودي", "saudi"], ["عراقي", "iraqi"],
  ["ليبي", "libyan"], ["لبناني", "lebanese"], ["سوداني", "sudanese"], ["فلسطيني", "palestinian"], ["أردني", "jordanian"],
  ["المغرب", "moroccan"], ["الجزائر", "algerian"], ["تونس", "tunisian"], ["موريتانيا", "mauritanian"],
  ["بحريني", "bahraini"],
];
const ARAB = new Set(["saudi", "iraqi", "libyan", "lebanese", "sudanese", "palestinian", "jordanian", "moroccan", "algerian", "tunisian", "mauritanian", "bahraini", "arab"]);

function norm(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/_/g, " ").split(/\s+/).filter(Boolean).join(" ");
}
function number(value: unknown): number {
  const parsed = Number(String(value ?? "").trim().replace(/,/g, "").replace(/%/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
function asArray(value: XmlValue): XmlValue[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
function child(node: XmlValue, key: string): XmlValue {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  return (node as XmlObject)[key];
}
function textValue(value: XmlValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  const text = child(value, "#text");
  return text == null ? "" : textValue(text);
}
function descendants(node: XmlValue, key: string): XmlValue[] {
  const found: XmlValue[] = [];
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const item of node) found.push(...descendants(item, key));
    return found;
  }
  for (const [name, value] of Object.entries(node as XmlObject)) {
    if (name === key) found.push(...asArray(value));
    else found.push(...descendants(value, key));
  }
  return found;
}
function firstText(node: XmlValue, key: string): string {
  const direct = child(node, key);
  if (direct !== undefined) return textValue(direct);
  return textValue(descendants(node, key)[0]);
}
function parseXml(xml: string, filename: string): XmlValue {
  try {
    return parser.parse(xml);
  } catch {
    throw new Error("تعذر قراءة ملف " + filename + ". تأكد أن الملف XML صالح.");
  }
}

function loadNat(xml: string, exclusions: { code: string; count: number }[] = []) {
  const root = parseXml(xml, "nat.xml");
  const bycat: Record<string, number> = {};
  const countryRows: [string, string, number, string][] = [];
  let totalSum = 0;
  for (const country of descendants(root, "G_COUNTRY_CODE")) {
    const name = firstText(country, "COUNTRY_NAME").trim();
    const code = firstText(country, "COUNTRY_CODE").trim();
    const value = descendants(country, "VALUE").reduce<number>(
      (sum, v) => sum + number(textValue(v)),
      0
    );
    const cat = ALIASES[norm(name)] ?? "other";
    bycat[cat] = (bycat[cat] ?? 0) + value;
    totalSum += value;
    countryRows.push([name || "غير معروف", code, value, cat]);
  }
  const totalNode = descendants(root, "SUMVALUEPERVALUE_CODE")[0];
  const totalText = textValue(totalNode);
  const total = totalText.trim() ? number(totalText) : totalSum;
  if (!countryRows.length) throw new Error("لم يتم العثور على بيانات G_COUNTRY_CODE في nat.xml. تحقق من الملف.");
  const requested = new Map<string, number>();
  for (const item of exclusions) {
    const code = String(item.code ?? "").trim().toUpperCase();
    const count = Number(item.count);
    if (!/^[A-Z]{2,3}$/.test(code) || !Number.isInteger(count) || count < 1) {
      throw new Error("بيانات الاستثناء غير صحيحة. اختر كود جنسية صحيحًا وعددًا صحيحًا أكبر من صفر.");
    }
    requested.set(code, (requested.get(code) ?? 0) + count);
  }
  for (const [code, count] of requested) {
    const matching = countryRows.filter((row) =>
      row[1].trim().toUpperCase() === code || (code === "ES" && row[3] === "spanish")
    );
    const available = matching.reduce((sum, row) => sum + row[2], 0);
    if (!matching.length) throw new Error("كود الجنسية " + code + " غير موجود في ملف nat.xml.");
    if (count > available) throw new Error("عدد الاستثناء المطلوب للجنسية " + code + " هو " + count + "، بينما العدد الموجود في الملف " + available + " فقط.");
    let remaining = count;
    for (const row of matching) {
      const deduction = Math.min(row[2], remaining);
      row[2] -= deduction;
      remaining -= deduction;
      bycat[row[3]] = Math.max(0, (bycat[row[3]] ?? 0) - deduction);
      total -= deduction;
      if (remaining === 0) break;
    }
  }
  return { bycat, total, countryRows };
}

function loadMan(xml: string) {
  const root = parseXml(xml, "man.xml");
  const wanted: Record<string, string> = {
    OCC_MINUS_COMP_HU: "النسبة",
    OCC_PERC_WO_CH: "الغرف المشغولة",
    ARRIVAL_ROOMS: "عدد غرف الوصول",
  };
  const values: Record<string, number> = {};
  for (const node of descendants(root, "G_MASTER_VALUE")) {
    const code = firstText(node, "SUB_GRP_1").trim();
    if (!wanted[code]) continue;
    for (const heading of descendants(node, "G_HEADING_1_ORDER")) {
      if (firstText(heading, "HEADING_2").trim().toUpperCase() !== "DAY") continue;
      let amount = firstText(heading, "SUM_AMOUNT");
      if (!amount) amount = firstText(heading, "FORMATTED_AMOUNT");
      if (amount.trim()) {
        values[code] = number(amount);
        if (code === "OCC_PERC_WO_CH") values[code] = Math.round(values[code] * 100) / 100;
        break;
      }
    }
  }
  return { values, wanted };
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const nat = form.get("nat");
    const man = form.get("man");
    let exclusions: { code: string; count: number }[] = [];
    const exclusionsRaw = form.get("exclusions");
    if (typeof exclusionsRaw === "string" && exclusionsRaw.trim()) {
      try {
        const parsed = JSON.parse(exclusionsRaw);
        if (!Array.isArray(parsed)) throw new Error();
        exclusions = parsed.map((item) => ({ code: String(item?.code ?? ""), count: Number(item?.count) }));
      } catch {
        return NextResponse.json({ error: "صيغة بيانات الاستثناءات غير صحيحة." }, { status: 400 });
      }
    }
    if (!(nat instanceof File) || !(man instanceof File)) {
      return NextResponse.json({ error: "يجب رفع الملفين nat.xml وman.xml." }, { status: 400 });
    }
    if (nat.size > 20 * 1024 * 1024 || man.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "حجم كل ملف يجب ألا يتجاوز 20 ميجابايت." }, { status: 413 });
    }
    const [natXml, manXml] = await Promise.all([nat.text(), man.text()]);
    const { bycat, total, countryRows } = loadNat(natXml, exclusions);
    const { values: manValues } = loadMan(manXml);
    const egyptians = bycat.egyptian ?? 0;
    const arabs = [...ARAB].reduce((sum, key) => sum + (bycat[key] ?? 0), 0);
    const foreigners = total - egyptians - arabs;
    const detailSum = DETAILS.reduce((sum, [, key]) => sum + (bycat[key] ?? 0), 0);
    const multi = foreigners - detailSum;
    const rows: [string, number | string][] = [
      ["النسبة", manValues.OCC_MINUS_COMP_HU ?? 0],
      ["الغرف المشغولة", manValues.OCC_PERC_WO_CH ?? 0],
      ["المصريون", egyptians], ["العرب", arabs], ["الأجانب", foreigners], ["", ""],
      ...DETAILS.map(([label, key]) => [label, bycat[key] ?? 0] as [string, number]),
      ["", ""], ["متعدد الوصول", multi], ["عدد غرف الوصول", manValues.ARRIVAL_ROOMS ?? 0],
    ];

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "التقرير اليومي للجنسيات";
    workbook.created = new Date();
    const ws = workbook.addWorksheet("تقرير يومي", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    ws.addRow(["البند", "القيمة"]);
    for (const row of rows) ws.addRow(row);
    ws.columns = [{ width: 30 }, { width: 18 }];
    const blue = "1F4E78", pale = "D9EAF7", green = "E2F0D9";
    ws.getRow(1).eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + blue } };
      cell.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" }, size: 12 };
      cell.alignment = { horizontal: "center" };
    });
    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      row.eachCell((cell, colNumber) => {
        cell.font = { name: "Arial", size: 11 };
        cell.border = { bottom: { style: "thin", color: { argb: "FFD9E1F2" } } };
        cell.alignment = { horizontal: colNumber === 1 ? "right" : "center" };
      });
      const label = String(row.getCell(1).value ?? "");
      if (["النسبة", "الغرف المشغولة", "المصريون", "العرب", "الأجانب"].includes(label)) {
        row.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + pale } };
          cell.font = { name: "Arial", bold: true, size: 11 };
        });
      }
      if (["متعدد الوصول", "عدد غرف الوصول"].includes(label)) {
        row.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + green } };
          cell.font = { name: "Arial", bold: true, size: 11 };
        });
      }
    }
    const audit = workbook.addWorksheet("تفاصيل الجنسيات", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    audit.addRow(["اسم الجنسية في XML", "كود الدولة", "القيمة بعد الاستثناء", "التصنيف"]);
    for (const row of [...countryRows].sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()))) audit.addRow(row);
    audit.columns = [{ width: 32 }, { width: 16 }, { width: 14 }, { width: 22 }];
    audit.getRow(1).eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + blue } };
      cell.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
    });
    audit.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      row.eachCell((cell) => {
        cell.font = { name: "Arial", size: 11 };
        cell.border = { bottom: { style: "thin", color: { argb: "FFD9E1F2" } } };
      });
    });
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="nationality_report.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "حدث خطأ أثناء معالجة ملفات XML.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
