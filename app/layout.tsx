import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "التقرير اليومي للجنسيات",
  description: "إنشاء تقرير Excel للجنسيات والغرف من ملفات nat.xml وman.xml",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}</body></html>;
}
