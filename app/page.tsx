"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import GuestNameExtractorPage from "./guest-name-extractor/page";
import RCPreview from "./rc-preview";
import { useFileLibrary } from "./file-library-provider";

type Exclusion = { id: number; code: string; count: number };
type ManagerRow = { room: string; towel: string; nationality: boolean; profile: string; isHouseUse: boolean };
type ArrivalRecord = { id: number; code: string; count: number; arrivalDate: string; departureDate: string };
type ManualAddition = { id: number; code: string; count: number };
const STORAGE_KEY = "nationality-report-exclusions-v1";
const ARRIVAL_STORAGE_KEY = "nationality-report-arrivals-v1";
const ADDITION_STORAGE_KEY = "nationality-report-additions-v1";
const ACTIVE_TOOL_STORAGE_KEY = "nationality-report-active-tool-v1";
const COUNTRIES = [["ES","إسبانيا"],["DE","ألمانيا"],["GB","بريطانيا"],["US","الولايات المتحدة"],["UA","أوكرانيا"],["RU","روسيا"],["BE","بلجيكا"],["PL","بولندا"],["CN","الصين"],["FR","فرنسا"],["IT","إيطاليا"],["IN","الهند"],["JP","اليابان"],["HR","كرواتيا"],["PK","باكستان"],["IR","إيران"],["IL","إسرائيل"],["SA","السعودية"],["IQ","العراق"],["LY","ليبيا"],["SD","السودان"],["PS","فلسطين"],["JO","الأردن"],["MA","المغرب"],["DZ","الجزائر"],["TN","تونس"],["MR","موريتانيا"],["BH","البحرين"],["EG","مصر"],["AE","الإمارات"],["KW","الكويت"],["QA","قطر"],["OM","عُمان"],["YE","اليمن"],["SY","سوريا"],["LB","لبنان"],["NL","هولندا"],["AT","النمسا"],["CH","سويسرا"],["SE","السويد"],["NO","النرويج"],["DK","الدنمارك"],["FI","فنلندا"],["CZ","التشيك"],["SK","سلوفاكيا"],["HU","المجر"],["RO","رومانيا"],["BG","بلغاريا"],["GR","اليونان"],["TR","تركيا"],["CA","كندا"],["AU","أستراليا"],["BR","البرازيل"],["MX","المكسيك"],["ZA","جنوب أفريقيا"]] as const;

export default function Home() {
  const { reservations: sharedReservations, registrations: sharedRegistrations, refreshFolder: refreshSharedFolder } = useFileLibrary();
  const [natFile, setNatFile] = useState<File | null>(null);
  const [manFile, setManFile] = useState<File | null>(null);
  const [roomInhFile, setRoomInhFile] = useState<File | null>(null);
  const [compRooms, setCompRooms] = useState("0");
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [arrivalRecords, setArrivalRecords] = useState<ArrivalRecord[]>([]);
  const [additions, setAdditions] = useState<ManualAddition[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<"error" | "success" | "info">("info");
  const [activeTool, setActiveTool] = useState<string>("nationality");
  const [managerTowelFile, setManagerTowelFile] = useState<File | null>(null);
  const [managerInhFile, setManagerInhFile] = useState<File | null>(null);
  const [managerNationalityFile, setManagerNationalityFile] = useState<File | null>(null);
  const [managerRows, setManagerRows] = useState<ManagerRow[]>([]);
  const [managerRoomFilter, setManagerRoomFilter] = useState<"all" | "house-use" | "guest-in-house">("all");
  const [managerBusy, setManagerBusy] = useState(false);
  const [managerMessage, setManagerMessage] = useState("");
  const [towelFile, setTowelFile] = useState<File | null>(null);
  const [inhFile, setInhFile] = useState<File | null>(null);
  const [missingRooms, setMissingRooms] = useState<string[]>([]);
  const [excludedRooms, setExcludedRooms] = useState<string[]>([]);
  const [towelMismatches, setTowelMismatches] = useState<{ room: string; adults: number; children: number; expectedTowels: number; actualTowels: number; isHouseUse?: boolean }[]>([]);
  const [towelBusy, setTowelBusy] = useState(false);
  const [towelMessage, setTowelMessage] = useState("");
  const [nationalityMissingFile, setNationalityMissingFile] = useState<File | null>(null);
  const [nationalityMissingRooms, setNationalityMissingRooms] = useState<string[]>([]);
  const [nationalityMissingBusy, setNationalityMissingBusy] = useState(false);
  const [nationalityMissingMessage, setNationalityMissingMessage] = useState("");
  const [profileFile, setProfileFile] = useState<File | null>(null);
  const [profileRows, setProfileRows] = useState<{ room: string; mainName: string; accompanyingNames: string[]; names: string[]; adults: number; children: number; expected: number; found: number; difference: number; company: string; arrival: string; departure: string; status: "missing" | "extra" | "complete" }[]>([]);
  const [profileSummary, setProfileSummary] = useState<{ totalRooms: number; checkedRooms: number; mismatchCount: number; missingCount: number; extraCount: number } | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const [profileShowNames, setProfileShowNames] = useState(false);
  const [profileHideHouseUse, setProfileHideHouseUse] = useState(true);
  const [profileDifferenceFilter, setProfileDifferenceFilter] = useState<"all" | "missing" | "extra">("all");
  const [profileSelectedCompanies, setProfileSelectedCompanies] = useState<string[]>([]);
  const [profileVisibleColumns, setProfileVisibleColumns] = useState<string[]>(["room","adults","children","expected","found","difference","company","arrival","departure","names"]);
  const [euroRate, setEuroRate] = useState("");
  const [journalFile, setJournalFile] = useState<File | null>(null);
  const [journalRows, setJournalRows] = useState<{ code: string; description: string; room: string; guestName: string; debit: string; credit: string; date: string; time: string }[]>([]);
  const [journalSummary, setJournalSummary] = useState<{ code: string; description: string; count: number }[]>([]);
  const [journalBusy, setJournalBusy] = useState(false);
  const [journalMessage, setJournalMessage] = useState("");
  const [fixedChargeFile, setFixedChargeFile] = useState<File | null>(null);
  const [fixedChargeRows, setFixedChargeRows] = useState<{ room: string; guestName: string; code: string; description: string; price: string; quantity: string; frequency: string; beginDate: string; endDate: string }[]>([]);
  const [fixedChargeBusy, setFixedChargeBusy] = useState(false);
  const [fixedChargeMessage, setFixedChargeMessage] = useState("");
  const [rcResFile, setRcResFile] = useState<File | null>(null);
  const [rcPdfFiles, setRcPdfFiles] = useState<File[]>([]);
  const [rcMissingRooms, setRcMissingRooms] = useState<string[]>([]);
  const [rcSummary, setRcSummary] = useState<{ totalRooms: number; matchedRooms: number; missingCount: number; pdfFiles: number; pdfRoomsCount: number } | null>(null);
  const [rcBusy, setRcBusy] = useState(false);
  const [rcMessage, setRcMessage] = useState("");
  const [rcFolderPath, setRcFolderPath] = useState("");

  useEffect(() => {
    if (activeTool !== "rc-missing" || !window.desktopBridge) return;
    let active = true;
    void window.desktopBridge.getSavedFolderPath().then((savedPath) => {
      if (active) setRcFolderPath(savedPath || "");
    }).catch(() => { if (active) setRcFolderPath(""); });
    return () => { active = false; };
  }, [activeTool]);

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
    try {
      const savedTool = localStorage.getItem(ACTIVE_TOOL_STORAGE_KEY);
      const validTools = ["nationality", "towels", "nationality-missing", "missing-profile", "manager-report", "journal", "rc-missing", "rc-preview", "guest-name-extractor"];
      if (savedTool && validTools.includes(savedTool)) {
        setActiveTool(savedTool);
      }
    } catch { /* تجاهل تعذر استعادة الأداة النشطة */ }
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

  useEffect(() => {
    if (ready) localStorage.setItem(ACTIVE_TOOL_STORAGE_KEY, activeTool);
  }, [activeTool, ready]);

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
      setTowelMessage("يجب أن يكون ملف الجنسيات وملف man.xml بصيغة XML.");
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
      setTowelMessage(`انتهى الفحص: ${result.count} غرفة بها اختلاف في العدد، ويشمل الفحص ${result.houseUseCount || 0} غرفة تابعة لـ House use.`);
    } catch (error) {
      setTowelMessage(error instanceof Error ? error.message : "حدث خطأ أثناء مراجعة أعداد المناشف.");
    } finally {
      setTowelBusy(false);
    }
  }

  async function detectMissingNationalities() {
    if (!nationalityMissingFile) { setNationalityMissingMessage("من فضلك اختر تقرير Guest INH By Nationality أولاً."); return; }
    if (!nationalityMissingFile.name.toLowerCase().endsWith(".xml")) { setNationalityMissingMessage("يجب أن يكون الملف بصيغة XML."); return; }
    setNationalityMissingBusy(true);
    setNationalityMissingMessage("جارٍ فحص الغرف التي لا تحتوي على كود جنسية...");
    setNationalityMissingRooms([]);
    try {
      const data = new FormData();
      data.append("file", nationalityMissingFile);
      const response = await fetch("/api/nationality-missing", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "تعذر فحص تقرير الجنسيات.");
      setNationalityMissingRooms(result.rooms || []);
      setNationalityMissingMessage(result.count ? "اكتمل الفحص: " + result.count + " غرفة بدون جنسية، من " + result.missingNationalityRecords + " سجل بدون كود جنسية." : "اكتمل الفحص: جميع سجلات الغرف تحتوي على كود جنسية.");
    } catch (error) {
      setNationalityMissingMessage(error instanceof Error ? error.message : "حدث خطأ أثناء فحص التقرير.");
    } finally { setNationalityMissingBusy(false); }
  }

  async function copyNationalityMissingRooms() {
    try {
      await navigator.clipboard.writeText(nationalityMissingRooms.join(","));
      setNationalityMissingMessage("تم نسخ " + nationalityMissingRooms.length + " رقم غرفة بصيغة comma separated.");
    } catch { setNationalityMissingMessage("تعذر النسخ تلقائيًا. يمكنك تحديد الأرقام في المربع ونسخها يدويًا."); }
  }


  async function detectMissingProfiles() {
    if (!profileFile) { setProfileMessage("من فضلك اختر تقرير Guests INH - By Room أولاً."); return; }
    if (!profileFile.name.toLowerCase().endsWith(".xml")) { setProfileMessage("يجب أن يكون الملف بصيغة XML."); return; }
    setProfileBusy(true);
    setProfileMessage("جارٍ مقارنة عدد الأشخاص بالأسماء المسجلة...");
    setProfileRows([]);
    setProfileSummary(null);
    try {
      const data = new FormData();
      data.append("file", profileFile);
      const response = await fetch("/api/missing-profile", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "تعذر فحص تقرير الغرف.");
      setProfileRows(result.rows || []);
      setProfileSummary({ totalRooms: result.totalRooms, checkedRooms: result.checkedRooms, mismatchCount: result.mismatchCount, missingCount: result.missingCount, extraCount: result.extraCount });
      setProfileMessage("اكتمل الفحص: تمت مراجعة " + result.checkedRooms + " غرفة. توجد " + result.mismatchCount + " غرفة تحتاج إلى مراجعة (" + result.missingCount + " ناقص، " + result.extraCount + " زيادة).");
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : "حدث خطأ أثناء فحص التقرير.");
    } finally { setProfileBusy(false); }
  }

  async function copyProfileRooms() {
    try {
      await navigator.clipboard.writeText(profileRows.map((row) => row.room).join(","));
      setProfileMessage("تم نسخ " + profileRows.length + " رقم غرفة.");
    } catch { setProfileMessage("تعذر النسخ تلقائيًا. يمكنك تحديد الأرقام ونسخها يدويًا."); }
  }

  const visibleManagerRows = managerRows.filter((row) => managerRoomFilter === "all" || (managerRoomFilter === "house-use" ? row.isHouseUse : !row.isHouseUse));

  async function generateManagerReport() {
    if (!managerTowelFile || !managerInhFile || !managerNationalityFile) {
      setManagerMessage("من فضلك ارفع التقارير الثلاثة المطلوبة قبل إنشاء التقرير.");
      return;
    }
    const files = [managerTowelFile, managerInhFile, managerNationalityFile];
    if (files.some((file) => !file.name.toLowerCase().endsWith(".xml"))) {
      setManagerMessage("يجب أن تكون جميع الملفات بصيغة XML.");
      return;
    }
    setManagerBusy(true);
    setManagerRows([]);
    setManagerMessage("جارٍ فحص التقارير الثلاثة وتجميع النتائج...");
    try {
      const towelData = new FormData();
      towelData.append("file", managerTowelFile);
      towelData.append("inhFile", managerInhFile);
      towelData.append("mode", "consistency");
      const profileData = new FormData();
      profileData.append("file", managerInhFile);
      const nationalityData = new FormData();
      nationalityData.append("file", managerNationalityFile);
      const [towelResponse, profileResponse, nationalityResponse] = await Promise.all([
        fetch("/api/missing-towels", { method: "POST", body: towelData }),
        fetch("/api/missing-profile", { method: "POST", body: profileData }),
        fetch("/api/nationality-missing", { method: "POST", body: nationalityData }),
      ]);
      const [towelResult, profileResult, nationalityResult] = await Promise.all([towelResponse.json(), profileResponse.json(), nationalityResponse.json()]);
      if (!towelResponse.ok) throw new Error(towelResult.error || "تعذر فحص تقرير Towel Card.");
      if (!profileResponse.ok) throw new Error(profileResult.error || "تعذر فحص تقرير Profiles.");
      if (!nationalityResponse.ok) throw new Error(nationalityResult.error || "تعذر فحص تقرير الجنسيات.");

      const towelMap = new Map<string, { expected: number; towels: number | null; isHouseUse: boolean }>();
      for (const item of (towelResult.roomCounts || [])) towelMap.set(item.room, { expected: Number(item.expected) || 0, towels: item.towels == null ? null : Number(item.towels), isHouseUse: Boolean(item.isHouseUse) });
      const profileMap = new Map<string, { expected: number; found: number; company: string }>();
      for (const item of (profileResult.allRows || profileResult.rows || [])) profileMap.set(item.room, { expected: Number(item.expected) || 0, found: Number(item.found) || 0, company: String(item.company || "") });
      const nationalityRooms = new Set<string>(nationalityResult.rooms || []);
      const allRooms = new Set<string>([...towelMap.keys(), ...profileMap.keys(), ...nationalityRooms]);
      const rows: ManagerRow[] = [...allRooms].sort((a, b) => Number(a) - Number(b)).flatMap((room) => {
        const towel = towelMap.get(room);
        const profile = profileMap.get(room);
        const expected = profile?.expected || towel?.expected || 0;
        const towelCount = towel?.towels ?? 0;
        const profileCount = profile?.found ?? 0;
        const nationality = !nationalityRooms.has(room);
        const isHouseUse = Boolean(towel?.isHouseUse) || /house\s*use/i.test(profile?.company || "");
        const resolvedHouseUse = isHouseUse && expected > 0 && towelCount === 0 && nationality && Boolean(profile) && profileCount === expected;
        if (resolvedHouseUse) return [];
        const hasProblem = !towel || towelCount !== expected || !nationality || !profile || profileCount !== expected;
        if (!hasProblem) return [];
        return [{ room, towel: `${towelCount}/${expected}`, nationality, profile: `${profileCount}/${expected}`, isHouseUse }];
      });
      setManagerRows(rows);
      setManagerMessage(`اكتمل التقرير: تم العثور على ${rows.length} غرفة تحتاج إلى متابعة.`);
    } catch (error) {
      setManagerMessage(error instanceof Error ? error.message : "حدث خطأ أثناء إنشاء Manager Report.");
    } finally { setManagerBusy(false); }
  }

  function printManagerReport() {
    const previousTitle = document.title;
    document.title = " ";
    window.print();
    document.title = previousTitle;
  }

  function toEuro(amount: string) {
    const rate = Number(euroRate);
    const egp = Number(String(amount ?? "").replace(/,/g, "").trim());
    if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(egp)) return "";
    return (egp / rate).toFixed(2);
  }

  function dateDifferenceDays(beginDate: string, endDate: string) {
    const parseDate = (value: string) => {
      const text = String(value ?? "").trim();
      let year: number, month: number, day: number;
      let match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
      if (match) {
        day = Number(match[1]);
        month = Number(match[2]);
        year = Number(match[3]);
        if (year < 100) year += 2000;
      } else {
        match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
        if (!match) return null;
        year = Number(match[1]);
        month = Number(match[2]);
        day = Number(match[3]);
      }
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
      return date;
    };
    const begin = parseDate(beginDate);
    const end = parseDate(endDate);
    if (!begin || !end) return null;
    return Math.round((end.getTime() - begin.getTime()) / 86400000);
  }

  function fixedChargeTotal(row: { beginDate: string; endDate: string; price: string }) {
    const days = dateDifferenceDays(row.beginDate, row.endDate);
    const euro = Number(toEuro(row.price));
    if (days === null || !Number.isFinite(euro)) return "";
    return (days * euro).toFixed(2);
  }

  async function detectJournal() {
    if (!Number.isFinite(Number(euroRate)) || Number(euroRate) <= 0) { setJournalMessage("من فضلك أدخل سعر اليورو بالجنيه المصري بشكل صحيح أولاً."); return; }
    if (!journalFile) { setJournalMessage("من فضلك اختر تقرير Journal by Cashier and Transaction Code أولاً."); return; }
    if (!journalFile.name.toLowerCase().endsWith(".xml")) { setJournalMessage("يجب أن يكون الملف بصيغة XML."); return; }
    setJournalBusy(true);
    setJournalMessage("جارٍ استخراج الحركات...");
    setJournalRows([]);
    setJournalSummary([]);
    try {
      const data = new FormData();
      data.append("file", journalFile);
      const response = await fetch("/api/journal-detector", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "تعذر استخراج بيانات Journal.");
      setJournalRows(result.rows || []);
      setJournalSummary(result.summary || []);
      setJournalMessage("اكتمل الاستخراج: " + result.count + " حركة من " + result.codesFound + " كود.");
    } catch (error) {
      setJournalMessage(error instanceof Error ? error.message : "حدث خطأ أثناء استخراج التقرير.");
    } finally { setJournalBusy(false); }
  }

  function downloadJournalCsv() {
    const headers = ["Transaction Code", "Transaction Description", "Room", "Guest Name", "Debit", "EUR", "Credit", "Date", "Time"];
    const values = journalRows.map((row) => [row.code, row.description, row.room, row.guestName, row.debit, toEuro(row.debit), row.credit, row.date, row.time]);
    const csvCell = (value: string) => '"' + String(value ?? "").replace(/"/g, '""') + '"';
    const csv = "\uFEFF" + [headers, ...values].map((line) => line.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "journal-detector.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function detectFixedCharges() {
    if (!Number.isFinite(Number(euroRate)) || Number(euroRate) <= 0) { setFixedChargeMessage("من فضلك أدخل سعر اليورو بالجنيه المصري بشكل صحيح أولاً."); return; }
    if (!fixedChargeFile) { setFixedChargeMessage("من فضلك اختر تقرير الوصول RES_DETAIL أولاً."); return; }
    if (!fixedChargeFile.name.toLowerCase().endsWith(".xml")) { setFixedChargeMessage("يجب أن يكون الملف بصيغة XML."); return; }
    setFixedChargeBusy(true);
    setFixedChargeMessage("جارٍ البحث عن 1012 Fixed Charges...");
    setFixedChargeRows([]);
    try {
      const data = new FormData();
      data.append("file", fixedChargeFile);
      const response = await fetch("/api/journal-fixed-charges", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "تعذر فحص تقرير الوصول.");
      setFixedChargeRows(result.rows || []);
      setFixedChargeMessage("تم فحص " + result.reservationsScanned + " سجل وصول. وُجد " + result.roomCount + " غرفة لديها 1012 Fixed Charges (" + result.count + " سجل رسوم).");
    } catch (error) {
      setFixedChargeMessage(error instanceof Error ? error.message : "حدث خطأ أثناء فحص تقرير الوصول.");
    } finally { setFixedChargeBusy(false); }
  }

  function downloadFixedChargesCsv() {
    const headers = ["Room", "Guest Name", "Transaction Code", "Description", "Price", "EUR", "Quantity", "Frequency", "Begin Date", "End Date", "Total"];
    const values = fixedChargeRows.map((row) => [row.room, row.guestName, row.code, row.description, row.price, toEuro(row.price), row.quantity, row.frequency, row.beginDate, row.endDate, fixedChargeTotal(row)]);
    const csvCell = (value: string) => '"' + String(value ?? "").replace(/"/g, '""') + '"';
    const csv = "\uFEFF" + [headers, ...values].map((line) => line.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "fixed-charges-1012-rooms.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
  function extractPdfRoomsFromFiles(files: Array<{ name: string }>) {
    const rooms = new Set<string>();
    const pdfFiles = files.filter((file) => file.name.toLowerCase().endsWith(".pdf"));
    for (const file of pdfFiles) {
      const base = file.name.replace(/\.pdf$/i, "");
      if (/^\d{1,2}[-_.]\d{1,2}[-_.]\d{4}$/.test(base)) continue;
      const matches = base.match(/(?<!\d)\d{3,4}(?!\d)/g) || [];
      matches.forEach((room) => rooms.add(room.padStart(4, "0")));
    }
    return { rooms: [...rooms], pdfFiles: pdfFiles.length };
  }

  function normalizeRCRoom(value: unknown) {
    const room = String(value ?? "").trim();
    return /^\d{3,4}$/.test(room) ? room.padStart(4, "0") : "";
  }

  async function extractRCRoomsFromArrivalPdf(file: File): Promise<string[]> {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const rooms = new Set<string>();
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
        "str" in item && "transform" in item && Boolean(item.str?.trim()),
      ).map((item) => ({ x: item.transform[4], y: item.transform[5], text: item.str.trim() }));
      const rows: { y: number; cells: { x: number; text: string }[] }[] = [];
      for (const item of items) {
        let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 5);
        if (!row) { row = { y: item.y, cells: [] }; rows.push(row); }
        row.cells.push({ x: item.x, text: item.text });
      }
      const lines = rows.sort((a, b) => b.y - a.y).map((row) =>
        row.cells.sort((a, b) => a.x - b.x).map((cell) => cell.text).join(" ").replace(/\s+/g, " ").trim(),
      );
      const isRoomLine = (line: string) => {
        const match = line.match(/^(\d{3,5})\s+(.+)$/);
        return Boolean(match && match[2].includes(",") && !/^\d{5,9}\b/.test(match[2]));
      };
      for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(/^(\d{3,5})\s+(.+)$/);
        if (!match || !match[2].includes(",")) continue;
        let confirmation = false;
        for (let next = index + 1; next < Math.min(index + 5, lines.length); next++) {
          if (isRoomLine(lines[next])) break;
          if (/^\s*\d{5,9}(?=\s|$)/.test(lines[next])) confirmation = true;
          if (confirmation) break;
        }
        if (confirmation) {
          const room = normalizeRCRoom(match[1]);
          if (room) rooms.add(room);
        }
      }
    }
    return [...rooms];
  }

  async function getRCPdfFileNames() {
    const manualNames = rcPdfFiles.map((file) => file.name);
    let folderNames: string[] = [];
    let folderPath = rcFolderPath;
    if (window.desktopBridge) {
      if (!folderPath) folderPath = await window.desktopBridge.getSavedFolderPath().catch(() => "");
      if (folderPath) {
        setRcFolderPath(folderPath);
        const entries = await window.desktopBridge.listFolderFiles(folderPath);
        folderNames = entries.filter((entry) => entry.name.toLowerCase().endsWith(".pdf")).map((entry) => entry.name);
      }
    }
    return { names: [...folderNames, ...manualNames], folderPath };
  }

  async function detectRCMissing() {
    if (!rcResFile) { setRcMessage("من فضلك اختر تقرير الوصول بصيغة RES_DETAIL.xml أو arr.pdf."); return; }
    const reportExtension = rcResFile.name.split(".").pop()?.toLowerCase();
    if (reportExtension !== "xml" && reportExtension !== "pdf") { setRcMessage("تقرير الوصول يجب أن يكون بصيغة XML أو PDF."); return; }
    if (rcPdfFiles.some((file) => !file.name.toLowerCase().endsWith(".pdf"))) { setRcMessage("اختر ملفات PDF فقط."); return; }
    setRcBusy(true);
    setRcMessage("جارٍ قراءة تقرير الوصول ومجلد الحجوزات...");
    setRcMissingRooms([]);
    setRcSummary(null);
    try {
      const { names, folderPath } = await getRCPdfFileNames();
      const { rooms, pdfFiles } = extractPdfRoomsFromFiles(names.map((name) => ({ name })));
      if (!pdfFiles) throw new Error("لم يتم العثور على ملفات PDF في مجلد الحجوزات المرتبط أو الملفات المحددة يدويًا.");
      const data = new FormData();
      if (reportExtension === "xml") {
        data.append("resFile", rcResFile);
      } else {
        setRcMessage("جارٍ استخراج أرقام الغرف من arr.pdf...");
        const reportRooms = await extractRCRoomsFromArrivalPdf(rcResFile);
        if (!reportRooms.length) throw new Error("لم يتم العثور على غرف في arr.pdf. تأكد أنه تقرير الوصول المعتاد الذي يحتوي على رقم الغرفة واسم النزيل ورقم التأكيد.");
        data.append("reportRooms", JSON.stringify(reportRooms));
        data.append("reportFileName", rcResFile.name);
      }
      data.append("pdfRooms", JSON.stringify(rooms));
      data.append("pdfFiles", String(pdfFiles));
      const response = await fetch("/api/rc-missing", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "تعذر فحص الملفات.");
      setRcMissingRooms(result.missingRooms || []);
      setRcSummary({ totalRooms: result.totalRooms, matchedRooms: result.matchedRooms, missingCount: result.missingCount, pdfFiles: result.pdfFiles, pdfRoomsCount: result.pdfRoomsCount });
      setRcMessage("اكتمل الفحص بنجاح. " + (folderPath ? "تمت قراءة ملفات PDF من مجلد الحجوزات المرتبط." : "تمت قراءة ملفات PDF المختارة يدويًا."));
    } catch (error) {
      setRcMessage(error instanceof Error ? error.message : "حدث خطأ أثناء فحص RC Missing.");
    } finally { setRcBusy(false); }
  }

  async function copyRCMissingRooms() {
    try {
      await navigator.clipboard.writeText(rcMissingRooms.join(","));
      setRcMessage("تم نسخ " + rcMissingRooms.length + " رقم غرفة.");
    } catch { setRcMessage("تعذر النسخ تلقائيًا. يمكنك تحديد الأرقام ونسخها يدويًا."); }
  }

  function downloadRCMissingCsv() {
    const csv = "\uFEFF" + ["Room", ...rcMissingRooms].map((value) => '"' + String(value).replace(/"/g, '""') + '"').join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "rc-missing-rooms.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function generateReport() {
    if (!natFile || (!roomInhFile && !manFile)) {
      setKind("error");
      setMessage("من فضلك اختر ملف الجنسيات nat.xml، ومعه ملف man.xml أو Guests INH - By Room على الأقل.");
      return;
    }
    if (!natFile.name.toLowerCase().endsWith(".xml") || (roomInhFile && !roomInhFile.name.toLowerCase().endsWith(".xml")) || (manFile && !manFile.name.toLowerCase().endsWith(".xml"))) {
      setKind("error");
      setMessage("يجب أن تكون الملفات المختارة بصيغة XML.");
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
      data.append("compRooms", compRooms);
      if (roomInhFile) data.append("roomInh", roomInhFile);
      if (manFile) data.append("man", manFile);
      data.append("exclusions", JSON.stringify(exclusions.map(({ code, count }) => ({ code, count }))));
      data.append("additions", JSON.stringify(additions.map(({ code, count }) => ({ code, count }))));
      data.append("arrivalRecords", JSON.stringify(arrivalRecords.map(({ code, count, arrivalDate, departureDate }) => ({ code, count, arrivalDate, departureDate }))));
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
        <h1>{activeTool === "nationality" ? "التقرير اليومي للجنسيات" : activeTool === "towels" ? "Missing Towel Detector" : activeTool === "nationality-missing" ? "Nationality missing detector" : activeTool === "missing-profile" ? "Missing Profile Detector" : activeTool === "manager-report" ? "Manager Report" : activeTool === "guest-name-extractor" ? "Guest Name Extractor" : activeTool === "rc-missing" ? "RC Missing" : activeTool === "rc-preview" ? "RC Preview" : "Journal Detector"}</h1>
        <p>{activeTool === "nationality" ? "حوّل ملفات nat.xml وman.xml إلى تقرير Excel، ويمكن إضافة Guests INH - By Room لإنشاء تبويب تفاصيل الغرف." : activeTool === "towels" ? "ارفع تقرير الغرف لاستخراج أرقام الغرف التي لا تحتوي على Towel Card." : activeTool === "nationality-missing" ? "ارفع Guest INH By Nationality لاستخراج أرقام الغرف التي لا تحتوي على كود جنسية." : activeTool === "missing-profile" ? "قارن عدد Adults + Children بعدد الأسماء المسجلة في Main Profile وAccompanying Names." : activeTool === "manager-report" ? "تقرير موحد للغرف التي بها نقص في كروت الفوط أو الجنسية أو ملفات النزلاء." : activeTool === "guest-name-extractor" ? "اختر مجلد الحجوزات للبحث داخل ملفات PDF وWord وOutlook عن اسم النزيل أو الشركة." : activeTool === "rc-missing" ? "قارن غرف تقرير RES_DETAIL مع أرقام الغرف الموجودة في أسماء ملفات PDF، واعرض الغرف التي لا يوجد لها PDF." : activeTool === "rc-preview" ? "ابحث عن بطاقات التسجيل حسب أرقام الغرف، واعرض صفحات PDF واطبع الصفحة المطلوبة دون تقارير وصول." : "ارفع Journal by Cashier and Transaction Code لاستخراج الحركات، أو RES_DETAIL لاستخراج غرف الوصول التي لديها 1012 Fixed Charges."}</p>
      </header>

      <section className="panel" aria-live="polite" style={{ padding: "12px 16px", marginBottom: 16 }}>
        <strong>مكتبة الملفات المشتركة</strong>
        <div className="uploads" style={{ marginTop: 8, alignItems: "center" }}>
          <span>الحجوزات: {sharedReservations.loading ? "جارٍ الفحص..." : sharedReservations.path ? sharedReservations.entries.length + " ملف" : "غير مرتبط"}</span>
          <span>نماذج التسجيل: {sharedRegistrations.loading ? "جارٍ الفحص..." : sharedRegistrations.path ? sharedRegistrations.entries.length + " ملف" : "غير مرتبط"}</span>
          <button type="button" className="add-button" disabled={sharedReservations.loading || sharedRegistrations.loading} onClick={() => { void Promise.all([refreshSharedFolder("reservations"), refreshSharedFolder("registration")]); }}>تحديث فهرس المجلدين</button>
        </div>
        {(sharedReservations.error || sharedRegistrations.error) && <p className="saved-hint">{[sharedReservations.error, sharedRegistrations.error].filter(Boolean).join(" — ")}</p>}
        <p className="saved-hint">يتم فحص المجلدين بالتوازي عند بدء التطبيق. يمكن للأدوات استخدام الملفات المشتركة مباشرة من المجلد الأصلي، وتُقرأ محتويات الملفات عند الحاجة دون رفعها مجددًا.</p>
      </section>

      <section className="panel tool-picker">
        <label htmlFor="tool-select">اختر الأداة</label>
        <select id="tool-select" value={activeTool} onChange={(e) => {
          setActiveTool(e.target.value);
        }}>
          <option value="nationality">التقرير اليومي للجنسيات</option>
          <option value="towels">Missing Towel Detector</option>
          <option value="nationality-missing">Nationality missing detector</option>
          <option value="missing-profile">Missing Profile Detector</option>
          <option value="manager-report">Manager Report</option>
          <option value="journal">Journal Detector</option>
          <option value="rc-missing">RC Missing</option>
          <option value="rc-preview">RC Preview</option>
          <option value="guest-name-extractor">فتح Guest Name Extractor</option>
        </select>
      </section>

      <div style={{ display: activeTool === "guest-name-extractor" ? "block" : "none" }}><GuestNameExtractorPage /></div>
      {activeTool === "guest-name-extractor" ? null : activeTool === "rc-preview" ? (
        <RCPreview />
      ) : activeTool === "nationality" ? (
        <>
      <section className="panel">
        <h2>إدارة البيانات والإعدادات</h2>
        <p className="muted">صدّر الاستثناءات وسجلات الوصول والإضافات اليدوية في ملف واحد، ثم استورده على أي جهاز لاستعادة نفس القيم.</p>
        <div className="uploads">
          <button type="button" className="button" onClick={exportSettings} disabled={!ready}>تنزيل نسخة احتياطية للإعدادات</button>
          <label className="button" htmlFor="settings-backup" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>استيراد نسخة احتياطية</label>
          <input id="settings-backup" type="file" accept=".json,application/json" onChange={importSettings} style={{ display: "none" }} />
        </div>
        <p className="saved-hint">النسخة تشمل الأقسام 2 و3 و4 فقط. ملفات التقارير XML لا تدخل في النسخة الاحتياطية، ويجب اختيارها من الجهاز عند إنشاء كل تقرير.</p>
      </section>

      <section className="panel">
        <h2>1. ملفات التقرير</h2>
        <p className="muted">ارفع تقارير ما قبل Night Run أو ملفات ما بعد Night Run. يمكنك استخدام nat.xml مع man.xml، أو تقارير ما قبل Night Run، أو الجمع بين الملفات حسب المتاح.</p>
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3>Before Night Run</h3>
          <div className="uploads">
            <div className="upload">
              <label htmlFor="room-inh">Guests INH - By Room</label>
              <input id="room-inh" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => setRoomInhFile(e.target.files?.[0] ?? null)} />
              {roomInhFile && <div className="filename">تم الاختيار: {roomInhFile.name}</div>}
            </div>
            <div className="upload">
              <label htmlFor="guest-inh">Guest INH By Nationality</label>
              <input id="guest-inh" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => setNatFile(e.target.files?.[0] ?? null)} />
              {natFile && <div className="filename">تم الاختيار: {natFile.name}</div>}
            </div>
          </div>
        </div>
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3>After Night Run</h3>
          <div className="uploads">
            <div className="upload">
              <label htmlFor="nat-after">nat.xml</label>
              <input id="nat-after" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => setNatFile(e.target.files?.[0] ?? null)} />
              {natFile && <div className="filename">ملف الجنسيات المختار: {natFile.name}</div>}
            </div>
            <div className="upload">
              <label htmlFor="man">man.xml</label>
              <input id="man" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => setManFile(e.target.files?.[0] ?? null)} />
              {manFile && <div className="filename">تم الاختيار: {manFile.name}</div>}
            </div>
          </div>
        </div>
        <div className="upload">
          <label htmlFor="comp-rooms">عدد غرف Comp</label>
          <input id="comp-rooms" type="number" min="0" step="1" value={compRooms} onChange={(e) => setCompRooms(e.target.value)} />
          <p className="saved-hint">النسبة عند توفر تقرير الغرف = 100 × (عدد غرف Guests بعد استبعاد House Use − Comp) ÷ 965.</p>
        </div>
        <button className="button" onClick={generateReport} disabled={busy || !ready || !natFile || (!roomInhFile && !manFile)}>{busy ? "جارٍ إنشاء التقرير..." : "إنشاء وتنزيل ملف Excel"}</button>
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
          <li>متعدد الوصول وعدد غرف الوصول من man.xml عند توفره، أو عدد غرف النزلاء من Guests INH - By Room عند غيابه.</li>
          <li>عدد الإنجليز الذين وصلوا في أحدث تاريخ وصول، عند استخدام Guest INH By Nationality.</li>
          <li>تبويب بيانات الغرف: إجمالي الغرف، غرف House use، غرف Guests، وأرقام الغرف مع اسم الشركة.</li>
          <li>ورقة ثانية تحتوي على تفاصيل الدول: الاسم كما ورد في XML، كود الدولة، القيمة، والتصنيف.</li>
        </ul>
      </section>
        </>
      ) : activeTool === "manager-report" ? (
        <section className="panel manager-panel">
          <h2>Manager Report</h2>
          <p className="muted">ارفع تقارير Towel Card وGuests INH - By Room وGuest INH By Nationality. سيظهر فقط الغرف التي تحتاج إلى متابعة في أي من الفحوص الثلاثة.</p>
          <div className="uploads manager-uploads">
            <div className="upload"><label htmlFor="manager-towel-file">1. Towel Card Report — tc.xml</label><input id="manager-towel-file" type="file" accept=".xml,text/xml,application/xml" onChange={(e)=>{setManagerTowelFile(e.target.files?.[0]??null);setManagerRows([]);setManagerMessage("");}} />{managerTowelFile&&<div className="filename">تم الاختيار: {managerTowelFile.name}</div>}</div>
            <div className="upload"><label htmlFor="manager-inh-file">2. Guests INH - By Room.xml</label><input id="manager-inh-file" type="file" accept=".xml,text/xml,application/xml" onChange={(e)=>{setManagerInhFile(e.target.files?.[0]??null);setManagerRows([]);setManagerMessage("");}} />{managerInhFile&&<div className="filename">تم الاختيار: {managerInhFile.name}</div>}</div>
            <div className="upload"><label htmlFor="manager-nationality-file">3. Guest INH By Nationality.xml</label><input id="manager-nationality-file" type="file" accept=".xml,text/xml,application/xml" onChange={(e)=>{setManagerNationalityFile(e.target.files?.[0]??null);setManagerRows([]);setManagerMessage("");}} />{managerNationalityFile&&<div className="filename">تم الاختيار: {managerNationalityFile.name}</div>}</div>
          </div>
          <div className="upload no-print"><label htmlFor="manager-room-filter">فلترة الغرف</label><select id="manager-room-filter" value={managerRoomFilter} onChange={(e) => setManagerRoomFilter(e.target.value as "all" | "house-use" | "guest-in-house")}><option value="all">الكل</option><option value="house-use">غرف House Use فقط</option><option value="guest-in-house">غرف Guest In House فقط</option></select></div>
          <button className="button no-print" onClick={generateManagerReport} disabled={managerBusy||!managerTowelFile||!managerInhFile||!managerNationalityFile}>{managerBusy?"جارٍ إعداد التقرير...":"إنشاء Manager Report"}</button>
          {managerMessage&&<div role="status" className="notice no-print">{managerMessage}</div>}
          {visibleManagerRows.length>0&&<div className="manager-results">
            <div className="section-heading no-print"><h3>الغرف التي تحتاج إلى متابعة ({visibleManagerRows.length})</h3><button type="button" className="add-button" onClick={printManagerReport}>طباعة / حفظ PDF</button></div>
            <div className="manager-print-title"><h2>Manager Report</h2><p>Rooms requiring attention: {visibleManagerRows.length}</p></div>
            <div className="table-wrap"><table className="manager-table" dir="ltr"><thead><tr><th>Room number</th><th>Towel</th><th>Nationality</th><th>Profile</th></tr></thead><tbody>{visibleManagerRows.map((row)=><tr key={row.room}><td>{row.room}</td><td>{row.towel}</td><td className={row.nationality?"manager-ok":"manager-error"}>{row.nationality?"✓":"✗"}</td><td>{row.profile}</td></tr>)}</tbody></table></div>
            <div className="manager-print-footer">created by: Daniel Atef</div>
          </div>}
          {managerRows.length===0&&managerMessage.startsWith("اكتمل التقرير")&&<p className="saved-hint no-print">لا توجد غرف بها مشكلات. جميع الغرف اجتازت الفحوص الثلاثة.</p>}{managerRows.length>0&&visibleManagerRows.length===0&&<p className="saved-hint no-print">لا توجد غرف بها مشكلات ضمن نوع الغرف المحدد.</p>}
        </section>
      ) : activeTool === "towels" ? (
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
            <p className="muted">يشمل الفحص غرف النزلاء وHouse Use. في غرف النزلاء تتم مقارنة Towel Card مع Adults + Children. أما غرف House Use فأي قيمة غير فارغة في Towel Card تُعتبر خطأ وتظهر في القائمة مهما كان الرقم، بينما القيمة الفارغة تُعتبر طبيعية ولا تظهر.</p>
            <button type="button" className="button" onClick={checkTowelCounts} disabled={towelBusy || !towelFile || !inhFile}>{towelBusy ? "جارٍ الفحص..." : "فحص أخطاء عدد Towel Card"}</button>
            {towelMismatches.length > 0 && (
              <>
                <h3>الغرف التي بها اختلاف ({towelMismatches.length})</h3>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>الغرفة</th><th>النوع</th><th>Adults</th><th>Children</th><th>المفترض</th><th>Towel Card</th></tr></thead>
                    <tbody>
                      {towelMismatches.map((item) => (
                        <tr key={item.room}>
                          <td>{item.room}</td><td>{item.isHouseUse ? "House Use" : "Guest"}</td><td>{item.adults}</td><td>{item.children}</td>
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

      ) : activeTool === "missing-profile" ? (
        <section className="panel">
          <h2>Missing Profile Detector</h2>
          <p className="muted">قارن عدد Adults + Children بعدد الأسماء المسجلة في Main Profile وAccompanying Names.</p>
          <div className="upload">
            <label htmlFor="missing-profile-file">تقرير الغرف — Guests INH - By Room.xml</label>
            <input id="missing-profile-file" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => { setProfileFile(e.target.files?.[0] ?? null); setProfileRows([]); setProfileSummary(null); setProfileMessage(""); setProfileSelectedCompanies([]); }} />
            {profileFile && <div className="filename">تم الاختيار: {profileFile.name}</div>}
          </div>
          <button className="button" onClick={detectMissingProfiles} disabled={profileBusy || !profileFile}>{profileBusy ? "جارٍ الفحص..." : "فحص ملفات النزلاء"}</button>
          {profileMessage && <div role="status" className="notice">{profileMessage}</div>}
          {profileSummary && (
            <div className="towel-results">
              <div className="section-heading"><h3>ملخص الفحص</h3><button type="button" className="add-button" onClick={copyProfileRooms} disabled={profileRows.length === 0}>نسخ أرقام الغرف المعروضة</button></div>
              <div className="stats-grid">
                <div><strong>{profileSummary.checkedRooms}</strong><span>إجمالي الغرف المفحوصة</span></div>
                <div><strong>{profileSummary.mismatchCount}</strong><span>غرف تحتاج مراجعة</span></div>
                <div><strong>{profileSummary.missingCount}</strong><span>أسماء ناقصة</span></div>
                <div><strong>{profileSummary.extraCount}</strong><span>أسماء زائدة</span></div>
              </div>
            </div>
          )}
          {profileRows.length > 0 && (() => {
            const companies = Array.from(new Set(profileRows.map((row) => row.company).filter(Boolean))).sort();
            const filteredRows = profileRows.filter((row) => {
              const isHouseUse = /house\\s*use/i.test(row.company);
              if (profileHideHouseUse && isHouseUse) return false;
              if (profileSelectedCompanies.length > 0 && !profileSelectedCompanies.includes(row.company)) return false;
              if (profileDifferenceFilter === "missing" && row.status !== "missing") return false;
              if (profileDifferenceFilter === "extra" && row.status !== "extra") return false;
              return true;
            });
            const columns: [string,string][] = [["room","الغرفة"],["adults","Adults"],["children","Children"],["expected","المتوقع"],["found","المسجل"],["difference","الفرق"],["company","الشركة"],["arrival","الوصول"],["departure","المغادرة"],["names","الأسماء"]];
            const showColumn = (key: string) => profileVisibleColumns.includes(key) && (key !== "names" || profileShowNames);
            return (
              <div className="towel-results">
                <h3>الغرف التي تحتاج إلى مراجعة ({filteredRows.length} من {profileRows.length})</h3>
                <button type="button" className="add-button" disabled={filteredRows.length===0} onClick={async()=>{try{await navigator.clipboard.writeText(filteredRows.map((row)=>row.room).join(","));setProfileMessage("تم نسخ "+filteredRows.length+" رقم غرفة ظاهرة بعد تطبيق الفلاتر.");}catch{setProfileMessage("تعذر النسخ تلقائياً. حاول استخدام اتصال آمن أو نسخ الأرقام يدوياً.");}}}>نسخ أرقام الغرف الظاهرة (,)</button>
                <div className="panel" style={{ marginBottom: 16 }}>
                  <h3>فلاتر العرض</h3>
                  <label style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                    <input type="checkbox" checked={profileShowNames} onChange={(e)=>setProfileShowNames(e.target.checked)} />
                    إظهار أسماء النزلاء (مخفية افتراضياً)
                  </label>
                  <label style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                    <input type="checkbox" checked={profileHideHouseUse} onChange={(e)=>setProfileHideHouseUse(e.target.checked)} />
                    إخفاء غرف House Use
                  </label>
                  <div style={{marginBottom:12}}>
                    <strong>نوع الفرق</strong>
                    <div className="uploads" style={{marginTop:8}}>
                      <label style={{display:"inline-flex",alignItems:"center",gap:6}}>
                        <input type="radio" name="profile-difference-filter" checked={profileDifferenceFilter==="all"} onChange={()=>setProfileDifferenceFilter("all")} />
                        عرض الناقص والزائد
                      </label>
                      <label style={{display:"inline-flex",alignItems:"center",gap:6}}>
                        <input type="radio" name="profile-difference-filter" checked={profileDifferenceFilter==="missing"} onChange={()=>setProfileDifferenceFilter("missing")} />
                        المتوقع أكبر من المسجل (أسماء ناقصة)
                      </label>
                      <label style={{display:"inline-flex",alignItems:"center",gap:6}}>
                        <input type="radio" name="profile-difference-filter" checked={profileDifferenceFilter==="extra"} onChange={()=>setProfileDifferenceFilter("extra")} />
                        المسجل أكبر من المتوقع (أسماء زائدة)
                      </label>
                    </div>
                  </div>
                  <div style={{marginBottom:12}}>
                    <strong>الأعمدة الظاهرة</strong>
                    <div className="uploads" style={{marginTop:8}}>
                      {columns.map(([key,label]) => <label key={key} style={{display:"inline-flex",alignItems:"center",gap:6}}>
                        <input type="checkbox" checked={showColumn(key)} disabled={key==="names" && !profileShowNames} onChange={(e)=>setProfileVisibleColumns((prev)=>e.target.checked?[...prev,key]:prev.filter((x)=>x!==key))} />
                        {label}
                      </label>)}
                    </div>
                  </div>
                  <div>
                    <strong>الشركات</strong>
                    <p className="saved-hint">اترك جميع الشركات بدون تحديد لعرض الكل، أو اختر شركة واحدة أو أكثر لتصفية النتائج.</p>
                    <div className="uploads">
                      {companies.map((company) => <label key={company} style={{display:"inline-flex",alignItems:"center",gap:6}}>
                        <input type="checkbox" checked={profileSelectedCompanies.includes(company)} onChange={(e)=>setProfileSelectedCompanies((prev)=>e.target.checked?[...prev,company]:prev.filter((x)=>x!==company))} />
                        {company}
                      </label>)}
                    </div>
                    {profileSelectedCompanies.length>0 && <button type="button" className="add-button" onClick={()=>setProfileSelectedCompanies([])}>عرض كل الشركات</button>}
                  </div>
                </div>
                {filteredRows.length === 0 ? <p className="empty-exclusions">لا توجد غرف تطابق الفلاتر الحالية.</p> : (
                  <div className="table-wrap"><table>
                    <thead><tr>{columns.filter(([key])=>showColumn(key)).map(([key,label])=><th key={key}>{label}</th>)}</tr></thead>
                    <tbody>{filteredRows.map((row)=><tr key={row.room}>
                      {showColumn("room")&&<td>{row.room}</td>}
                      {showColumn("adults")&&<td>{row.adults}</td>}
                      {showColumn("children")&&<td>{row.children}</td>}
                      {showColumn("expected")&&<td>{row.expected}</td>}
                      {showColumn("found")&&<td>{row.found}</td>}
                      {showColumn("difference")&&<td>{row.status==="missing"?"ناقص "+row.difference:"زائد "+Math.abs(row.difference)}</td>}
                      {showColumn("company")&&<td>{row.company}</td>}
                      {showColumn("arrival")&&<td>{row.arrival}</td>}
                      {showColumn("departure")&&<td>{row.departure}</td>}
                      {showColumn("names")&&<td style={{minWidth:260,whiteSpace:"normal"}}>
                        {row.mainName&&<div><strong>Main:</strong> {row.mainName}</div>}
                        {row.accompanyingNames.length>0&&<div><strong>Accompanying:</strong> {row.accompanyingNames.join(" / ")}</div>}
                        {!row.names.length&&<span>لا توجد أسماء مسجلة</span>}
                      </td>}
                    </tr>)}</tbody>
                  </table></div>
                )}
                <p className="saved-hint">Main Profile يُحسب اسماً واحداً، وكل اسم في Accompanying Names بعد الفصل بعلامة / يُحسب شخصاً مستقلاً.</p>
              </div>
            );
          })()}
        </section>
      ) : activeTool === "nationality-missing" ? (
        <section className="panel">
          <h2>Nationality missing detector</h2>
          <p className="muted">ارفع تقرير Guest INH By Nationality. تفحص الأداة سجلات G_C12 وتحدد الغرف التي يكون فيها كود الجنسية C69 فارغًا، مع حذف التكرارات وترتيب أرقام الغرف تصاعديًا.</p>
          <div className="upload">
            <label htmlFor="nationality-missing-file">تقرير الجنسيات — Guest INH By Nationality.xml</label>
            <input id="nationality-missing-file" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => { setNationalityMissingFile(e.target.files?.[0] ?? null); setNationalityMissingRooms([]); setNationalityMissingMessage(""); }} />
            {nationalityMissingFile && <div className="filename">تم الاختيار: {nationalityMissingFile.name}</div>}
          </div>
          <button className="button" onClick={detectMissingNationalities} disabled={nationalityMissingBusy || !nationalityMissingFile}>{nationalityMissingBusy ? "جارٍ الفحص..." : "فحص الغرف بدون جنسية"}</button>
          {nationalityMissingMessage && <div role="status" className="notice">{nationalityMissingMessage}</div>}
          {nationalityMissingRooms.length > 0 && (
            <div className="towel-results">
              <div className="section-heading">
                <h3>الغرف التي لا تحتوي على جنسية ({nationalityMissingRooms.length})</h3>
                <button type="button" className="add-button" onClick={copyNationalityMissingRooms}>نسخ الأرقام</button>
              </div>
              <textarea readOnly value={nationalityMissingRooms.join(",")} rows={5} aria-label="أرقام الغرف بدون جنسية بصيغة comma separated" />
              <p className="saved-hint">الأرقام مرتبة تصاعديًا ومفصولة بفواصل، مع الاحتفاظ بصفر بداية رقم الغرفة.</p>
            </div>
          )}
        </section>
      ) : activeTool === "rc-missing" ? (
        <section className="panel">
          <h2>RC Missing</h2>
          <p className="muted">ارفع تقرير الوصول RES_DETAIL.xml أو arr.pdf. ستقرأ الأداة ملفات PDF مباشرة من آخر مجلد حجوزات مرتبط في Guest Name Extractor، بما في ذلك المجلدات الداخلية، ويمكنك أيضًا اختيار ملفات PDF يدويًا عند الحاجة. تستخرج أرقام الغرف من أسماء الملفات وتحول الرقم الثلاثي إلى أربعة أرقام بإضافة صفر في البداية.</p>
          <div className="upload">
            <label htmlFor="rc-res-file">تقرير الوصول — RES_DETAIL.xml أو arr.pdf</label>
            <input id="rc-res-file" type="file" accept=".xml,.pdf,text/xml,application/xml,application/pdf" onChange={(e) => { setRcResFile(e.target.files?.[0] ?? null); setRcMissingRooms([]); setRcSummary(null); setRcMessage(""); }} />
            {rcResFile && <div className="filename">تم الاختيار: {rcResFile.name}</div>}
          </div>
          <div className="upload">
            <label htmlFor="rc-pdf-files">ملفات PDF إضافية (اختياري — يمكن تحديد عدة ملفات)</label>
            <input id="rc-pdf-files" type="file" accept=".pdf,application/pdf" multiple onChange={(e) => { setRcPdfFiles(Array.from(e.target.files || [])); setRcMissingRooms([]); setRcSummary(null); setRcMessage(""); }} />
            {rcPdfFiles.length > 0 && <div className="filename">تم اختيار {rcPdfFiles.length} ملف PDF إضافي</div>}
            {rcFolderPath && <div className="filename" dir="ltr">مجلد الحجوزات المرتبط: {rcFolderPath}</div>}
            {!rcFolderPath && <div className="saved-hint">لم يتم العثور على مجلد محفوظ من Guest Name Extractor. يمكنك ربط مجلد من هناك أولًا أو اختيار ملفات PDF يدويًا.</div>}
          </div>
          <button className="button" onClick={detectRCMissing} disabled={rcBusy || !rcResFile}>{rcBusy ? "جارٍ الفحص..." : "فحص الغرف الناقصة"}</button>
          {rcMessage && <div role="status" className="notice">{rcMessage}</div>}
          {rcSummary && (
            <div className="towel-results">
              <h3>ملخص الفحص</h3>
              <div className="summary-grid">
                <div><strong>{rcSummary.totalRooms}</strong><span>إجمالي غرف الوصول</span></div>
                <div><strong>{rcSummary.matchedRooms}</strong><span>غرف لها ملفات PDF</span></div>
                <div><strong>{rcSummary.missingCount}</strong><span>غرف بدون PDF</span></div>
                <div><strong>{rcSummary.pdfFiles}</strong><span>عدد ملفات PDF المختارة</span></div>
              </div>
              <div className="section-heading">
                <h3>الغرف التي لا يوجد لها PDF ({rcMissingRooms.length})</h3>
                {rcMissingRooms.length > 0 && <div className="uploads">
                  <button type="button" className="add-button" onClick={copyRCMissingRooms}>نسخ الأرقام</button>
                  <button type="button" className="add-button" onClick={downloadRCMissingCsv}>تنزيل CSV لفتحه في Excel</button>
                </div>}
              </div>
              {rcMissingRooms.length > 0 ? <textarea readOnly value={rcMissingRooms.join(",")} rows={5} aria-label="الغرف التي لا يوجد لها PDF" /> : <p className="saved-hint">ممتاز! جميع غرف تقرير الوصول لها ملفات PDF مطابقة.</p>}
            </div>
          )}
        </section>
      ) : (
        <section className="panel">
          <h2>Journal Detector</h2>
          <p className="muted">ارفع تقرير Journal by Cashier and Transaction Code بصيغة XML. ستُستخرج الأكواد التالية فقط: 1010, 1012, 1014, 1019, 1020, 1025, 4500, 4501, 5001, 5003, 5005, 5008, 5009, 5086. باقي الأكواد يتم تجاهلها.</p>
          <div className="upload">
            <label htmlFor="euro-rate">سعر اليورو الحالي بالجنيه المصري (1 EUR = EGP)</label>
            <input id="euro-rate" type="number" min="0.01" step="0.01" placeholder="مثال: 55.00" value={euroRate} onChange={(e) => setEuroRate(e.target.value)} />
            <p className="saved-hint">سيتم حساب قيمة EUR بقسمة المبلغ بالجنيه المصري على سعر اليورو المدخل. يُستخدم السعر في تقرير Journal وكذلك 1012 Fixed Charges.</p>
          </div>
          <div className="upload">
            <label htmlFor="journal-file">تقرير Journal by Cashier and Transaction Code</label>
            <input id="journal-file" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => { setJournalFile(e.target.files?.[0] ?? null); setJournalRows([]); setJournalSummary([]); setJournalMessage(""); }} />
            {journalFile && <div className="filename">تم الاختيار: {journalFile.name}</div>}
          </div>
          <button className="button" onClick={detectJournal} disabled={journalBusy || !journalFile}>{journalBusy ? "جارٍ الاستخراج..." : "استخراج بيانات الأكواد"}</button>
          {journalMessage && <div role="status" className="notice">{journalMessage}</div>}
          {journalSummary.length > 0 && (
            <div className="towel-results">
              <h3>ملخص الأكواد الموجودة ({journalSummary.length})</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>الكود</th><th>الوصف</th><th>عدد الحركات</th></tr></thead>
                  <tbody>{journalSummary.map((item) => <tr key={item.code}><td>{item.code}</td><td>{item.description}</td><td>{item.count}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
          )}
          {journalRows.length > 0 && (
            <div className="towel-results">
              <div className="section-heading">
                <h3>تفاصيل الحركات ({journalRows.length})</h3>
                <button type="button" className="add-button" onClick={downloadJournalCsv}>تنزيل CSV لفتحه في Excel</button>
              </div>
              <div dir="ltr" style={{ direction: "ltr", textAlign: "left" }}>
                {journalSummary.map((group, groupIndex) => {
                  const codeRows = journalRows.filter((row) => row.code === group.code);
                  return (
                    <section key={group.code} style={{ borderTop: groupIndex === 0 ? "2px solid #888" : "2px solid #888", paddingTop: 12, marginTop: 16 }}>
                      <h3 style={{ direction: "ltr", textAlign: "left", marginBottom: 10 }}>
                        Code: {group.code} {group.description ? "— " + group.description : ""} ({codeRows.length})
                      </h3>
                      <div className="table-wrap" style={{ direction: "ltr" }}>
                        <table dir="ltr" style={{ direction: "ltr", textAlign: "left" }}>
                          <thead><tr><th>Room</th><th>Guest Name</th><th>Debit</th><th>EUR</th><th>Credit</th><th>Date</th><th>Time</th></tr></thead>
                          <tbody>
                            {codeRows.map((row, index) => <tr key={row.code + "-" + row.room + "-" + index}>
                              <td>{row.room}</td><td>{row.guestName}</td><td>{row.debit}</td><td>{toEuro(row.debit)}</td><td>{row.credit}</td><td>{row.date}</td><td>{row.time}</td>
                            </tr>)}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          )}
          <div style={{ borderTop: "2px solid #888", marginTop: 28, paddingTop: 20 }}>
            <h3>استخراج غرف الوصول التي لديها 1012 Fixed Charges</h3>
            <p className="muted">ارفع تقرير RES_DETAIL الذي يحتوي على سجلات غرف الوصول. ستعرض الأداة الغرف التي يوجد داخل قائمة Fixed Charges الخاصة بها كود الحركة 1012 فقط، وتتجاهل بقية الأكواد.</p>
            <div className="upload">
              <label htmlFor="fixed-charge-file">تقرير الوصول — RES_DETAIL.xml</label>
              <input id="fixed-charge-file" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => { setFixedChargeFile(e.target.files?.[0] ?? null); setFixedChargeRows([]); setFixedChargeMessage(""); }} />
              {fixedChargeFile && <div className="filename">تم الاختيار: {fixedChargeFile.name}</div>}
            </div>
            <button className="button" onClick={detectFixedCharges} disabled={fixedChargeBusy || !fixedChargeFile}>{fixedChargeBusy ? "جارٍ الفحص..." : "استخراج غرف 1012 Fixed Charges"}</button>
            {fixedChargeMessage && <div role="status" className="notice">{fixedChargeMessage}</div>}
            {fixedChargeRows.length > 0 && (
              <div className="towel-results">
                <div className="section-heading">
                  <h3>الغرف التي لديها 1012 Fixed Charges ({new Set(fixedChargeRows.map((row) => row.room)).size})</h3>
                  <button type="button" className="add-button" onClick={downloadFixedChargesCsv}>تنزيل CSV لفتحه في Excel</button>
                </div>
                <textarea readOnly value={[...new Set(fixedChargeRows.map((row) => row.room))].join(",")} rows={2} aria-label="أرقام الغرف التي لديها 1012 Fixed Charges" />
                <div dir="ltr" style={{ direction: "ltr", textAlign: "left" }}>
                  <div className="table-wrap">
                    <table dir="ltr" style={{ direction: "ltr", textAlign: "left" }}>
                      <thead><tr><th>Room</th><th>Guest Name</th><th>Code</th><th>Description</th><th>Price</th><th>EUR</th><th>Frequency</th><th>Begin Date</th><th>End Date</th><th>Total</th></tr></thead>
                      <tbody>{fixedChargeRows.map((row, index) => <tr key={row.room + "-" + index}>
                        <td>{row.room}</td><td>{row.guestName}</td><td>{row.code}</td><td>{row.description}</td><td>{row.price}</td><td>{toEuro(row.price)}</td><td>{row.frequency}</td><td>{row.beginDate}</td><td>{row.endDate}</td><td>{fixedChargeTotal(row)}</td>
                      </tr>)}</tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
      <p className="foot">{activeTool === "journal" ? "يمكن تنزيل نتائج Journal Detector و1012 Fixed Charges بصيغة CSV وفتحها مباشرة في Excel." : activeTool === "rc-missing" ? "يمكن نسخ أرقام الغرف الناقصة أو تنزيلها في ملف CSV لفتحها في Excel." : "التقرير يُنشأ عند الطلب بصيغة Excel (.xlsx)."}</p>
    </main>
  );
}
