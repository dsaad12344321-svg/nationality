"use client";

import { useState } from "react";

export default function Home() {
  const [natFile, setNatFile] = useState<File | null>(null);
  const [manFile, setManFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<"error" | "success" | "info">("info");

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
    setBusy(true);
    setMessage("جارٍ قراءة الملفات وإنشاء تقرير Excel...");
    setKind("info");
    try {
      const data = new FormData();
      data.append("nat", natFile);
      data.append("man", manFile);
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
      setMessage("تم إنشاء التقرير وتنزيله بنجاح.");
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
        <button className="button" onClick={generateReport} disabled={busy}>{busy ? "جارٍ إنشاء التقرير..." : "إنشاء وتنزيل ملف Excel"}</button>
        {message && <div role="status" className={"notice " + (kind === "error" ? "error" : kind === "success" ? "success" : "")}>{message}</div>}
      </section>

      <section className="panel">
        <h2>2. محتويات التقرير</h2>
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
