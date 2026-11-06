"use client";

import { useEffect, useState, type ChangeEvent } from "react";

type Exclusion = { id: number; code: string; count: number };
type ArrivalRecord = { id: number; code: string; count: number; arrivalDate: string; departureDate: string };
type ManualAddition = { id: number; code: string; count: number };
const STORAGE_KEY = "nationality-report-exclusions-v1";
const ARRIVAL_STORAGE_KEY = "nationality-report-arrivals-v1";
const ADDITION_STORAGE_KEY = "nationality-report-additions-v1";
const COUNTRIES = [["ES","إسبانيا"],["DE","ألمانيا"],["GB","بريطانيا"],["US","الولايات المتحدة"],["UA","أوكرانيا"],["RU","روسيا"],["BE","بلجيكا"],["PL","بولندا"],["CN","الصين"],["FR","فرنسا"],["IT","إيطاليا"],["IN","الهند"],["JP","اليابان"],["HR","كرواتيا"],["PK","باكستان"],["IR","إيران"],["IL","إسرائيل"],["SA","السعودية"],["IQ","العراق"],["LY","ليبيا"],["SD","السودان"],["PS","فلسطين"],["JO","الأردن"],["MA","المغرب"],["DZ","الجزائر"],["TN","تونس"],["MR","موريتانيا"],["BH","البحرين"],["EG","مصر"],["AE","الإمارات"],["KW","الكويت"],["QA","قطر"],["OM","عُمان"],["YE","اليمن"],["SY","سوريا"],["LB","لبنان"],["NL","هولندا"],["AT","النمسا"],["CH","سويسرا"],["SE","السويد"],["NO","النرويج"],["DK","الدنمارك"],["FI","فنلندا"],["CZ","التشيك"],["SK","سلوفاكيا"],["HU","المجر"],["RO","رومانيا"],["BG","بلغاريا"],["GR","اليونان"],["TR","تركيا"],["CA","كندا"],["AU","أستراليا"],["BR","البرازيل"],["MX","المكسيك"],["ZA","جنوب أفريقيا"]] as const;

export default function Home() {
  const [natFile, setNatFile] = useState<File | null>(null);
  const [manFile, setManFile] = useState<File | null>(null);
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [arrivalRecords, setArrivalRecords] = useState<ArrivalRecord[]>([]);
  const [additions, setAdditions] = useState<ManualAddition[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<"error" | "success" | "info">("info");
  const [activeTool, setActiveTool] = useState<"nationality" | "towels">("nationality");
  const [towelFile, setTowelFile] = useState<File | null>(null);
  const [inhFile, setInhFile] = useState<File | null>(null);
  const [missingRooms, setMissingRooms] = useState<string[]>([]);
  const [excludedRooms, setExcludedRooms] = useState<string[]>([]);
  const [towelMismatches, setTowelMismatches] = useState<{ room: string; adults: number; children: number; expectedTowels: number; actualTowels: number }[]>([]);
  const [towelBusy, setTowelBusy] = useState(false);
  const [towelMessage, setTowelMessage] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setExclusions(parsed.map((item, index) => ({
          id: Number(item.id) || Date.now() + index,
          code: String(item.code || "ES").toUpperCase(),
          count: Math.max(1, Math.floor(Number(item.count) || 1)),
        })));
      }
    } catch { /* تجاهل الإعدادات المحفوظة غير الصالحة */ }
    try {
      const savedArrivals = localStorage.getItem(ARRIVAL_STORAGE_KEY);
      if (savedArrivals) {
        const parsedArrivals = JSON.parse(savedArrivals);
        if (Array.isArray(parsedArrivals)) setArrivalRecords(parsedArrivals.map((item, index) => ({
          id: Number(item.id) || Date.now() + index,
          code: String(item.code || "ES").toUpperCase(),
          count: Math.max(1, Math.floor(Number(item.count) || 1)),
          arrivalDate: String(item.arrivalDate || ""),
          departureDate: String(item.departureDate || ""),
        })));
      }
    } catch { /* تجاهل سجلات الوصول غير الصالحة */ }
    try {
      const savedAdditions = localStorage.getItem(ADDITION_STORAGE_KEY);
      if (savedAdditions) {
        const parsedAdditions = JSON.parse(savedAdditions);
        if (Array.isArray(parsedAdditions)) setAdditions(parsedAdditions.map((item, index) => ({
          id: Number(item.id) || Date.now() + index,
          code: String(item.code || "LY").toUpperCase(),
          count: Math.max(1, Math.floor(Number(item.count) || 1)),
        })));
      }
    } catch { /* تجاهل الإضافات اليدوية غير الصالحة */ }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(STORAGE_KEY, JSON.stringify(exclusions));
  }, [exclusions, ready]);

  useEffect(() => {
    if (ready) localStorage.setItem(ARRIVAL_STORAGE_KEY, JSON.stringify(arrivalRecords));
  }, [arrivalRecords, ready]);

  useEffect(() => {
    if (ready) localStorage.setItem(ADDITION_STORAGE_KEY, JSON.stringify(additions));
  }, [additions, ready]);

  function addExclusion() {
    setExclusions((items) => [...items, { id: Date.now(), code: "ES", count: 1 }]);
  }

  function addManualAddition() {
    setAdditions((items) => [...items, { id: Date.now(), code: "LY", count: 1 }]);
  }

  function addArrivalRecord() {
    setArrivalRecords((items) => [...items, { id: Date.now(), code: "ES", count: 1, arrivalDate: "", departureDate: "" }]);
  }

  function exportSettings() {
    const backup = {
      app: "nationality-report",
      version: 1,
      exportedAt: new Date().toISOString(),
      exclusions,
      arrivalRecords,
      additions,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nationality-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setKind("success");
    setMessage("تم تصدير جميع الإعدادات بنجاح. احتفظ بملف JSON لاستخدامه على أي جهاز.");
  }

  async function importSettings(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || parsed.app !== "nationality-report" || parsed.version !== 1 ||
          !Array.isArray(parsed.exclusions) || !Array.isArray(parsed.arrivalRecords) || !Array.isArray(parsed.additions)) {
        throw new Error("ملف النسخة الاحتياطية غير صالح أو لا يتوافق مع إصدار الموقع.");
      }
      const normalizeCount = (value: unknown) => {
        const count = Number(value);
        if (!Number.isInteger(count) || count < 1) throw new Error("يوجد عدد غير صحيح داخل ملف النسخة الاحتياطية.");
        return count;
      };
      const normalizeCode = (value: unknown) => {
        const code = String(value ?? "").trim().toUpperCase();
        if (!/^[A-Z]{2,3}$/.test(code)) throw new Error("يوجد كود جنسية غير صحيح داخل ملف النسخة الاحتياطية.");
        return code;
      };
      const normalizeId = (value: unknown, index: number) => Number(value) > 0 ? Number(value) : Date.now() + index;
      const restoredExclusions: Exclusion[] = parsed.exclusions.map((item: any, index: number) => ({
        id: normalizeId(item?.id, index), code: normalizeCode(item?.code), count: normalizeCount(item?.count),
      }));
      const restoredArrivals: ArrivalRecord[] = parsed.arrivalRecords.map((item: any, index: number) => ({
        id: normalizeId(item?.id, index), code: normalizeCode(item?.code), count: normalizeCount(item?.count),
        arrivalDate: String(item?.arrivalDate ?? ""), departureDate: String(item?.departureDate ?? ""),
      }));
      const restoredAdditions: ManualAddition[] = parsed.additions.map((item: any, index: number) => ({
        id: normalizeId(item?.id, index), code: normalizeCode(item?.code), count: normalizeCount(item?.count),
      }));
      setExclusions(restoredExclusions);
      setArrivalRecords(restoredArrivals);
      setAdditions(restoredAdditions);
      setKind("success");
      setMessage("تم استيراد الإعدادات الثلاثة بنجاح، وسيتم حفظها تلقائيًا على هذا الجهاز.");
    } catch (error) {
      setKind("error");
      setMessage(error instanceof Error ? error.message : "تعذر قراءة ملف النسخة الاحتياطية.");
    }
  }

  async function detectMissingTowels() {
    if (!towelFile || !inhFile) {
      setTowelMessage("من فضلك اختر ملف تقرير المناشف وملف Guests INH - By Room أولاً.");
      return;
    }
    if (!towelFile.name.toLowerCase().endsWith(".xml") || !inhFile.name.toLowerCase().endsWith(".xml")) {
      setTowelMessage("يجب أن يكون الملفان بصيغة XML.");
      return;
    }
    setTowelBusy(true);
    setTowelMessage("جارٍ فحص التقرير...");
    setMissingRooms([]);
    setExcludedRooms([]);
    try {
      const data = new FormData();
      data.append("file", towelFile);
      data.append("inhFile", inhFile);
      const response = await fetch("/api/missing-towels", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "تعذر فحص الملف.");
      setMissingRooms(result.rooms || []);
      setExcludedRooms(result.excludedRooms || []);
      setTowelMessage(`اكتمل الفحص: ${result.count} غرفة بدون Towel Card بعد استبعاد ${result.excludedCount || 0} غرفة تابعة لـ House use.`);
    } catch (error) {
      setTowelMessage(error instanceof Error ? error.message : "حدث خطأ أثناء فحص الملف.");
    } finally {
      setTowelBusy(false);
    }
  }

  async function copyMissingRooms() {
    try {
      await navigator.clipboard.writeText(missingRooms.join(","));
      setTowelMessage(`تم نسخ ${missingRooms.length} رقم غرفة.`);
    } catch {
      setTowelMessage("تعذر النسخ تلقائيًا. يمكنك تحديد النص ونسخه يدويًا.");
    }
  }

  async function checkTowelCounts() {
    if (!towelFile || !inhFile) {
      setTowelMessage("من فضلك اختر ملف tc.xml وملف Guests INH - By Room أولاً.");
      return;
    }
    setTowelBusy(true);
    setTowelMessage("جارٍ مراجعة تطابق أعداد النزلاء والمناشف...");
    setTowelMismatches([]);
    try {
      const data = new FormData();
      data.append("file", towelFile);
      data.append("inhFile", inhFile);
      data.append("mode", "consistency");
      const response = await fetch("/api/missing-towels", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "تعذر فحص تطابق الأعداد.");
      setTowelMismatches(result.mismatches || []);
      setExcludedRooms(result.excludedRooms || []);
      setTowelMessage(`انتهى الفحص: ${result.count} غرفة بها اختلاف في العدد، وتم تجاهل ${result.excludedCount || 0} غرفة تابعة لـ House use.`);
    } catch (error) {
      setTowelMessage(error instanceof Error ? error.message : "حدث خطأ أثناء مراجعة أعداد المناشف.");
    } finally {
      setTowelBusy(false);
    }
  }

  async function generateReport() {
    if (!natFile || !manFile) {
      setKind("error");
      setMessage("من فضلك اختر الملفين nat.xml وman.xml أولاً.");
      return;
    }
    if (!natFile.name.toLowerCase().endsWith(".xml") || !manFile.name.toLowerCase().endsWith(".xml")) {
      setKind("error");
      setMessage("يجب أن يكون الملفان بصيغة XML.");
      return;
    }
    if (exclusions.some((item) => !item.code || !Number.isInteger(item.count) || item.count < 1)) {
      setKind("error");
      setMessage("تأكد من اختيار الجنسية وإدخال عدد صحيح أكبر من صفر لكل استثناء.");
      return;
    }
    if (additions.some((item) => !item.code || !Number.isInteger(item.count) || item.count < 1)) {
      setKind("error");
      setMessage("تأكد من اختيار الجنسية وإدخال عدد صحيح أكبر من صفر لكل إضافة يدوية.");
      return;
    }
    setBusy(true);
    setMessage("جارٍ قراءة الملفات وإنشاء تقرير Excel...");
    setKind("info");
    try {
      const data = new FormData();
      data.append("nat", natFile);
      data.append("man", manFile);
      data.append("exclusions", JSON.stringify(exclusions.map(({ code, count }) => ({ code, count }))));
      data.append("additions", JSON.stringify(additions.map(({ code, count }) => ({ code, count }))));
      const response = await fetch("/api/report", { method: "POST", body: data });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "حدث خطأ غير متوقع." }));
        throw new Error(error.error || "تعذر إنشاء التقرير.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "nationality_report.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setKind("success");
      setMessage("تم إنشاء التقرير وتنزيله بنجاح، مع تطبيق الاستثناءات والإضافات اليدوية.");
    } catch (error) {
      setKind("error");
      setMessage(error instanceof Error ? error.message : "حدث خطأ أثناء إنشاء التقرير.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">أداة التقارير الفندقية</p>
        <h1>{activeTool === "nationality" ? "التقرير اليومي للجنسيات" : "Missing Towel Detector"}</h1>
        <p>{activeTool === "nationality" ? "حوّل ملفي nat.xml وman.xml إلى تقرير Excel منسق، يتضمن ملخص الجنسيات وبيانات الغرف وتفاصيل كل دولة." : "ارفع تقرير الغرف لاستخراج أرقام الغرف التي لا تحتوي على Towel Card."}</p>
      </header>

      <section className="panel tool-picker">
        <label htmlFor="tool-select">اختر الأداة</label>
        <select id="tool-select" value={activeTool} onChange={(e) => setActiveTool(e.target.value as "nationality" | "towels")}>
          <option value="nationality">التقرير اليومي للجنسيات</option>
          <option value="towels">Missing Towel Detector</option>
        </select>
      </section>

      {activeTool === "nationality" ? (
        <>
      <section className="panel">
        <h2>إدارة البيانات والإعدادات</h2>
        <p className="muted">صدّر الاستثناءات وسجلات الوصول والإضافات اليدوية في ملف واحد، ثم استورده على أي جهاز لاستعادة نفس القيم.</p>
        <div className="uploads">
          <button type="button" className="button" onClick={exportSettings} disabled={!ready}>تنزيل نسخة احتياطية للإعدادات</button>
          <label className="button" htmlFor="settings-backup" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>استيراد نسخة احتياطية</label>
          <input id="settings-backup" type="file" accept=".json,application/json" onChange={importSettings} style={{ display: "none" }} />
        </div>
        <p className="saved-hint">النسخة تشمل الأقسام 2 و3 و4 فقط. ملفات nat.xml وman.xml لا تدخل في النسخة الاحتياطية، ويجب اختيارها من الجهاز عند إنشاء كل تقرير.</p>
      </section>

      <section className="panel">
        <h2>1. اختر ملفات التقرير</h2>
        <p className="muted">اختر ملف الجنسيات nat.xml وملف بيانات الفندق man.xml من جهازك. تتم معالجة الملفات عند طلب إنشاء التقرير ولا يتم حفظها في الموقع.</p>
        <div className="uploads">
          <div className="upload">
            <label htmlFor="nat">ملف الجنسيات — nat.xml</label>
            <input id="nat" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => setNatFile(e.target.files?.[0] ?? null)} />
            {natFile && <div className="filename">تم الاختيار: {natFile.name}</div>}
          </div>
          <div className="upload">
            <label htmlFor="man">ملف بيانات الفندق — man.xml</label>
            <input id="man" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => setManFile(e.target.files?.[0] ?? null)} />
            {manFile && <div className="filename">تم الاختيار: {manFile.name}</div>}
          </div>
        </div>
        <button className="button" onClick={generateReport} disabled={busy || !ready}>{busy ? "جارٍ إنشاء التقرير..." : "إنشاء وتنزيل ملف Excel"}</button>
        {message && <div role="status" className={"notice " + (kind === "error" ? "error" : kind === "success" ? "success" : "")}>{message}</div>}
      </section>

      <section className="panel">
        <h2>2. استثناء أشخاص من جنسيات محددة</h2>
        <p className="muted">أضف الجنسية والعدد المراد استثناؤه. سيتم خصم العدد من إجمالي الجنسية ومن إجماليات التقرير المرتبطة بها.</p>
        {exclusions.map((item) => (
          <div className="exclusion-row" key={item.id}>
            <label>الجنسية
              <select value={item.code} onChange={(e) => setExclusions((items) => items.map((x) => x.id === item.id ? { ...x, code: e.target.value } : x))}>
                {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
              </select>
            </label>
            <label>العدد المستثنى
              <input type="number" min="1" step="1" value={item.count} onChange={(e) => setExclusions((items) => items.map((x) => x.id === item.id ? { ...x, count: Number(e.target.value) } : x))} />
            </label>
            <button type="button" className="remove-button" onClick={() => setExclusions((items) => items.filter((x) => x.id !== item.id))}>حذف</button>
          </div>
        ))}
        <button type="button" className="add-button" onClick={addExclusion}>＋ إضافة استثناء</button>
        <p className="saved-hint">يتم حفظ الاستثناءات تلقائيًا على هذا المتصفح، وستظل موجودة عند فتح الموقع مرة أخرى.</p>
      </section>

      <section className="panel">
        <h2>3. تسجيل الجنسيات ومواعيد الوصول والمغادرة</h2>
        <p className="muted">سجّل عدد الأشخاص من كل جنسية مع تاريخ الوصول وتاريخ المغادرة. هذه السجلات تُحفظ تلقائيًا في هذا المتصفح ولا تغيّر حسابات تقرير Excel أو الاستثناءات.</p>
        {arrivalRecords.length === 0 && <p className="empty-exclusions">لا توجد سجلات مضافة حتى الآن.</p>}
        {arrivalRecords.map((item) => (
          <div className="arrival-row" key={item.id}>
            <label>الجنسية
              <select value={item.code} onChange={(e) => setArrivalRecords((items) => items.map((x) => x.id === item.id ? { ...x, code: e.target.value } : x))}>
                {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
              </select>
            </label>
            <label>العدد
              <input type="number" min="1" step="1" value={item.count} onChange={(e) => setArrivalRecords((items) => items.map((x) => x.id === item.id ? { ...x, count: Number(e.target.value) } : x))} />
            </label>
            <label>تاريخ الوصول
              <input type="date" value={item.arrivalDate} onChange={(e) => setArrivalRecords((items) => items.map((x) => x.id === item.id ? { ...x, arrivalDate: e.target.value } : x))} />
            </label>
            <label>تاريخ المغادرة
              <input type="date" min={item.arrivalDate || undefined} value={item.departureDate} onChange={(e) => setArrivalRecords((items) => items.map((x) => x.id === item.id ? { ...x, departureDate: e.target.value } : x))} />
            </label>
            <button type="button" className="remove-button" onClick={() => setArrivalRecords((items) => items.filter((x) => x.id !== item.id))}>حذف</button>
          </div>
        ))}
        <button type="button" className="add-button" onClick={addArrivalRecord}>＋ إضافة سجل وصول</button>
        <p className="saved-hint">يتم حفظ هذه السجلات تلقائيًا على هذا المتصفح، وستظل موجودة عند فتح الموقع مرة أخرى.</p>
      </section>

      <section className="panel">
        <h2>4. إضافة جنسيات غير موجودة في nat.xml</h2>
        <p className="muted">استخدم هذا القسم عندما يكون لديك عدد مؤكد لجنسية غير ظاهر في ملف nat.xml. سيُضاف العدد إلى الجنسية وإجمالي التقرير، ثم تُعاد حسابات العرب والأجانب ومتعدد الوصول تلقائيًا.</p>
        {additions.length === 0 && <p className="empty-exclusions">لا توجد إضافات يدوية حتى الآن.</p>}
        {additions.map((item) => (
          <div className="exclusion-row" key={item.id}>
            <label>الجنسية
              <select value={item.code} onChange={(e) => setAdditions((items) => items.map((x) => x.id === item.id ? { ...x, code: e.target.value } : x))}>
                {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
              </select>
            </label>
            <label>العدد المراد إضافته
              <input type="number" min="1" step="1" value={item.count} onChange={(e) => setAdditions((items) => items.map((x) => x.id === item.id ? { ...x, count: Number(e.target.value) } : x))} />
            </label>
            <button type="button" className="remove-button" onClick={() => setAdditions((items) => items.filter((x) => x.id !== item.id))}>حذف</button>
          </div>
        ))}
        <button type="button" className="add-button" onClick={addManualAddition}>＋ إضافة جنسية / عدد</button>
        <p className="saved-hint">تُحفظ الإضافات تلقائيًا في هذا المتصفح. ستظهر في Excel كسجلات إضافة يدوية منفصلة عن بيانات XML.</p>
      </section>

      <section className="panel">
        <h2>5. محتويات التقرير</h2>
        <ul className="steps">
          <li>النسبة والغرف المشغولة والمصريون والعرب والأجانب.</li>
          <li>تفاصيل الجنسيات المحددة حسب التصنيفات الموجودة في الكود الأصلي.</li>
          <li>متعدد الوصول وعدد غرف الوصول، من بيانات DAY في ملف man.xml.</li>
          <li>ورقة ثانية تحتوي على تفاصيل الدول: الاسم كما ورد في XML، كود الدولة، القيمة، والتصنيف.</li>
        </ul>
      </section>
        </>
      ) : (
        <section className="panel">
          <h2>Missing Towel Detector</h2>
          <p className="muted">ارفع التقريرين معًا: تقرير Towel Card لاستخراج الغرف ذات القيمة الفارغة، وتقرير Guests INH - By Room لاستبعاد الغرف التي تكون Company Name فيها مثل T- House use. تتم مطابقة أرقام الغرف تلقائيًا بصيغة 4 خانات، والفلترة لا تتأثر بحالة الأحرف.</p>
          <div className="uploads">
            <div className="upload">
              <label htmlFor="towel-file">1. تقرير المناشف — tc.xml</label>
              <input id="towel-file" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => { setTowelFile(e.target.files?.[0] ?? null); setMissingRooms([]); setExcludedRooms([]); setTowelMismatches([]); setTowelMessage(""); }} />
              {towelFile && <div className="filename">تم الاختيار: {towelFile.name}</div>}
            </div>
            <div className="upload">
              <label htmlFor="inh-file">2. تقرير الإشغال — Guests INH - By Room</label>
              <input id="inh-file" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => { setInhFile(e.target.files?.[0] ?? null); setMissingRooms([]); setExcludedRooms([]); setTowelMessage(""); }} />
              {inhFile && <div className="filename">تم الاختيار: {inhFile.name}</div>}
            </div>
          </div>
          <button className="button" onClick={detectMissingTowels} disabled={towelBusy || !towelFile || !inhFile}>{towelBusy ? "جارٍ الفحص..." : "فحص الغرف واستبعاد House use"}</button>
          {towelMessage && <div role="status" className="notice">{towelMessage}</div>}
          {excludedRooms.length > 0 && (
            <div className="towel-results">
              <h3>الغرف المستبعدة بسبب Company Name = House use ({excludedRooms.length})</h3>
              <textarea readOnly value={excludedRooms.join(",")} rows={2} aria-label="الغرف المستبعدة بسبب House use" />
            </div>
          )}
          {missingRooms.length > 0 && (
            <div className="towel-results">
              <div className="section-heading">
                <h3>الغرف التي لا تحتوي على Towel Card ({missingRooms.length})</h3>
                <button type="button" className="add-button" onClick={copyMissingRooms}>نسخ القائمة</button>
              </div>
              <textarea readOnly value={missingRooms.join(",")} rows={5} aria-label="أرقام الغرف بدون Towel Card" />
              <p className="saved-hint">الناتج مفصول بفواصل، مثل: 0105,0121,0156,0159</p>
            </div>
          )}

          <div className="towel-results">
            <h3>أداة فرعية: مراجعة تطابق عدد النزلاء مع Towel Card</h3>
            <p className="muted">تراجع كل غرفة وفق القاعدة: Adults + Children = Towel Card. مثال: 2 بالغين + 2 أطفال يجب أن يكون Towel Card = 4. يتم استبعاد غرف House use تلقائيًا، كما يتم تجاهل قيمة Towel Card الفارغة لأنها تظهر في نتيجة الأداة الأصلية.</p>
            <button type="button" className="button" onClick={checkTowelCounts} disabled={towelBusy || !towelFile || !inhFile}>{towelBusy ? "جارٍ الفحص..." : "فحص أخطاء عدد Towel Card"}</button>
            {towelMismatches.length > 0 && (
              <>
                <h3>الغرف التي بها اختلاف ({towelMismatches.length})</h3>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>الغرفة</th><th>Adults</th><th>Children</th><th>المفترض</th><th>Towel Card</th></tr></thead>
                    <tbody>
                      {towelMismatches.map((item) => (
                        <tr key={item.room}>
                          <td>{item.room}</td><td>{item.adults}</td><td>{item.children}</td>
                          <td>{item.expectedTowels}</td><td>{item.actualTowels}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button type="button" className="add-button" onClick={() => navigator.clipboard.writeText(towelMismatches.map((item) => item.room).join(","))}>نسخ أرقام الغرف المخالفة</button>
              </>
            )}
            {towelMismatches.length === 0 && towelMessage.startsWith("انتهى الفحص:") && <p className="saved-hint">لم يتم العثور على اختلافات في الأعداد.</p>}
          </div>
        </section>
      )}
      <p className="foot">التقرير يُنشأ عند الطلب بصيغة Excel (.xlsx).</p>
    </main>
  );
}
