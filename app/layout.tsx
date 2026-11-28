import type { Metadata } from "next";
import "./globals.css";
import { FileLibraryProvider } from "./file-library-provider";

export const metadata: Metadata = {
  title: "التقرير اليومي للجنسيات",
  description: "إنشاء تقرير Excel للجنسيات والغرف من ملفات nat.xml وman.xml",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body><FileLibraryProvider>{children}</FileLibraryProvider></body></html>;
}
