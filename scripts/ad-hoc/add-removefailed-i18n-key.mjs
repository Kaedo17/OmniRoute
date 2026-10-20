#!/usr/bin/env node
/**
 * One-off: insert the `noAuthProvider.removeFailed` key beside
 * `createDahlTokenFailed` in every non-EN message catalog, with a per-locale
 * translation of the EN string "Failed to remove account".
 *
 * Anchor-based textual insert (all catalogs are gate-clean, so the anchor key
 * exists in every file) — preserves the files' existing formatting and keeps
 * the diff to exactly one added line per file.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.cwd(), "src/i18n/messages");
const TRANSLATIONS = {
  am: "Failed to remove account",
  ar: "فشل في إزالة الحساب",
  az: "Hesabı silmək alınmadı",
  bg: "Неуспешно премахване на профила",
  bn: "অ্যাকাউন্ট সরাতে ব্যর্থ হয়েছে",
  bs: "Brisanje naloga nije uspjelo",
  cs: "Odstranění účtu se nezdařilo",
  da: "Fjernelse af kontoen mislykkedes",
  de: "Konto konnte nicht entfernt werden",
  el: "Αποτυχία αφαίρεσης λογαριασμού",
  es: "No se pudo eliminar la cuenta",
  et: "Konto eemaldamine ebaõnnestus",
  fa: "حذف حساب ناموفق بود",
  fi: "Tilin poistaminen epäonnistui",
  fr: "Échec de la suppression du compte",
  ga: "Theip ar bhaint an chuntais",
  gu: "ખાતો દૂર કરવામાં નિષ્ફળ",
  ha: "Cire asusun bai yi nasara ba",
  he: "הסרת החשבון נכשלה",
  hi: "खाता हटाने में विफल",
  hr: "Uklanjanje računa nije uspjelo",
  hu: "A fiók eltávolítása nem sikerült",
  hy: "Չհաջողվեց հեռացնել հաշիվը",
  id: "Gagal menghapus akun",
  ig: "Ọ dọ nwepụ akụntụ adabara",
  it: "Impossibile rimuovere l'account",
  ja: "アカウントの削除に失敗しました",
  ka: "ანგარიშის წაშლა ვერ მოხერხდა",
  km: "បានបរាជ័យក្នុងការដកគណនីចេញ",
  kn: "ಖಾತೆಯನ್ನು ತೆಗೆದುಹಾರಲು ವಿಫಲವಾಗಿದೆ",
  ko: "계정을 삭제하지 못했습니다",
  lt: "Nepavyko pašalinti paskyrą",
  lv: "Neizdevās noņemt kontu",
  ml: "അക്കൗണ്ട് നീക്കം ചെയ്യുന്നതിൽ പരാജയപ്പെട്ടു",
  mr: "खाते काढण्यात अयशस्वी",
  ms: "Gagal membuang akaun",
  mt: "Ma rnexxiex tnehħi l-kont",
  my: "အကောင့်ကို ဖယ်ရှားရန် မအောင်မြင်ပါ",
  ne: "खाता हटाउन असफल भयो",
  nl: "Kon account niet verwijderen",
  no: "Fjerning av kontoen mislyktes",
  or: "ଆକାଉଣ୍ଟ ଅପସାରଣ ବିଫଳ ହେଲା",
  pa: "ਖਾਤਾ ਹਟਾਉਣ ਵਿੱਚ ਅਸਫਲ",
  phi: "Nabigo alisin ang account",
  pl: "Nie udało się usunąć konta",
  "pt-BR": "Falha ao remover a conta",
  pt: "Falha ao remover a conta",
  ro: "Eșec la eliminarea contului",
  ru: "Не удалось удалить аккаунт",
  si: "ගිණුම ඉවත් කිරීම අසාර්ථක විය",
  sk: "Odstránenie účtu sa nepodarilo",
  sl: "Odstranjevanje računa ni uspelo",
  sr: "Brisanje naloga nije uspelo",
  sv: "Det gick inte att ta bort kontot",
  sw: "Imeshindwa kuondoa akaunti",
  ta: "கணக்கை அகற்றுவதில் தோல்வி",
  te: "ఖాతాను తీసివేయడం విఫలమైంది",
  th: "ลบบัญชีไม่สำเร็จ",
  tr: "Hesap kaldırılamadı",
  "uk-UA": "Не вдалося видалити акаунт",
  ur: "اکاؤنٹ ہٹانے میں ناکام",
  uz: "Hisobni olib tashlash muvaffaqiyatsiz",
  vi: "Không thể xóa tài khoản",
  yo: "Ìkọ̀wọ́ ìyàkúrò akántì kò ṣẹ̀",
  "zh-CN": "移除账户失败",
  "zh-TW": "移除帳戶失敗",
};

let done = 0;
const issues = [];
const files = readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "en.json");
for (const f of files) {
  const loc = f.replace(".json", "");
  if (!(loc in TRANSLATIONS)) {
    issues.push(`${loc}: no translation`);
    continue;
  }
  const p = path.join(DIR, f);
  const src = readFileSync(p, "utf8");
  const anchor = src.match(/^([ \t]*)"createDahlTokenFailed":[^\n]*\n/m);
  if (!anchor) {
    issues.push(`${loc}: anchor not found`);
    continue;
  }
  // Idempotency check scoped to the noAuthProvider block: `removeFailed`
  // already exists under other namespaces (quotaShare), so a global search
  // would wrongly skip the file.
  const window = src.slice(anchor.index, anchor.index + 4000).split(/\n\s+(\w):\s*\{/)[0];
  if (window.includes('"removeFailed"')) {
    issues.push(`${loc}: key already present in block`);
    continue;
  }
  const indent = anchor[1];
  const esc = TRANSLATIONS[loc].replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const insert = anchor[0] + indent + `"removeFailed": "${esc}",\n`;
  writeFileSync(
    p,
    src.slice(0, anchor.index) + insert + src.slice(anchor.index + anchor[0].length)
  );
  done++;
}
console.log(`done: ${done}; issues: ${issues.length ? issues.join(", ") : "none"}`);
