"use client";

import { useEffect, useState } from "react";

type Exclusion = { id: number; code: string; count: number };
const STORAGE_KEY = "nationality-report-exclusions-v1";
const COUNTRIES = [["ES","إسبانيا"],["DE","ألمانيا"],["GB","بريطانيا"],["US","الولايات المتحدة"],["UA","أوكرانيا"],["RU","روسيا"],["BE","بلجيكا"],["PL","بولندا"],["CN","الصين"],["FR","فرنسا"],["IT","إيطاليا"],["IN","الهند"],["JP","اليابان"],["HR","كرواتيا"],["PK","باكستان"],["IR","إيران"],["IL","إسرائيل"],["SA","السعودية"],["IQ","العراق"],["LY","ليبيا"],["LB","لبنان"],["SD","السودان"],["PS","فلسطين"],["JO","الأردن"],["MA","المغرب"],["DZ","الجزائر"],["TN","تونس"],["MR","موريتانيا"],["BH","البحرين"],["EG","مصر"],["AE","الإمارات"],["KW","الكويت"],["QA","قطر"],["OM","عُمان"],["YE","اليمن"],["SY","سوريا"],["NL","هولندا"],["AT","النمسا"],["CH","سويسرا"],["SE","السويد"],["NO","النرويج"],["DK","الدنمارك"],["FI","فنلندا"],["CZ","التشيك"],["SK","سلوفاكيا"],["HU","المجر"],["RO","رومانيا"],["BG","بلغاريا"],["GR","اليونان"],["TR","تركيا"],["CA","كندا"],["AU","أستراليا"],["BR","البرازيل"],["MX","المكسيك"],["ZA","جنوب أفريقيا"]] as const;

export default function Home() {
  const [natFile, setNatFile] = useState<File | null>(null);
  const [manFile, setManFile] = useState<File | null>(null);
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<"error" | "success" | "info">("info");

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
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(STORAGE_KEY, JSON.stringify(exclusions));
  }, [exclusions, ready]);

  function addExclusion() {
    setExclusions((items) => [...items, { id: Date.now(), code: "ES", count: 1 }]);
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
    setBusy(true);
    setMessage("جارٍ قراءة الملفات وإنشاء تقرير Excel...");
    setKind("info");
    try {
      const data = new FormData();
      data.append("nat", natFile);
      data.append("man", manFile);
      data.append("exclusions", JSON.stringify(exclusions.map(({ code, count }) => ({ code, count }))));
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
      setMessage("تم إنشاء التقرير وتنزيله بنجاح. تم تطبيق الاستثناءات المحددة.");
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
        <h1>التقرير اليومي للجنسيات</h1>
        <p>حوّل ملفي nat.xml وman.xml إلى تقرير Excel منسق، يتضمن ملخص الجنسيات وبيانات الغرف وتفاصيل كل دولة.</p>
      </header>

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
        <h2>3. محتويات التقرير</h2>
        <ul className="steps">
          <li>النسبة والغرف المشغولة والمصريون والعرب والأجانب.</li>
          <li>تفاصيل الجنسيات المحددة حسب التصنيفات الموجودة في الكود الأصلي.</li>
          <li>متعدد الوصول وعدد غرف الوصول، من بيانات DAY في ملف man.xml.</li>
          <li>ورقة ثانية تحتوي على تفاصيل الدول: الاسم كما ورد في XML، كود الدولة، القيمة، والتصنيف.</li>
        </ul>
      </section>
      <p className="foot">التقرير يُنشأ عند الطلب بصيغة Excel (.xlsx).</p>
    </main>
  );
}
