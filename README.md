# Moms — bokföringsunderlag för enskild firma

Ett **enkelt och tydligt** personligt verktyg för momsredovisning och grundbokföring: verifikationer, momssummor och deadlines. Byggt med ren HTML, CSS och JavaScript — inget byggsteg, inga beroenden, inget konto krävs. All data sparas **lokalt i din webbläsare** (localStorage), med valfri privat molnsynk.

## Bokföringsmodell

Verifikationer är **orörliga** när de väl sparats — det finns ingen redigera- eller radera-funktion. Ett fel rättas genom att bokföra en **ny post** (stornering) som hänvisar till den felaktiga; originalet finns kvar oförändrat. Varje post får ett **löpande verifikationsnummer utan luckor**.

Varje verifikation innehåller:
- Verifikationsnummer (obrutet, löpande)
- Transaktionsdatum (affärshändelsen) + tidsstämpel för när posten bokfördes
- Typ: Försäljning, Inköp, Egen insättning eller Eget uttag
- Motpart, beskrivning, betalsätt/konto, referens till underlag
- Bruttobelopp du matar in — **netto och moms räknas ut baklänges** automatiskt (25/12/6/0 %)
- Valfri bild på kvittot

## Vad den gör

- **Verifikationer** — bokför inköp, försäljning, egna insättningar och egna uttag. Momsen räknas alltid ut från bruttobeloppet. Stöd för omvänd skattskyldighet vid EU-tjänsteinköp (t.ex. Stripe, Google Ads).
- **Rätta en post** — varje verifikation har en "Rätta"-knapp som förbereder en stornerande motpost. Inget skrivs över.
- **Momskalkylator** — baklängesmoms: skriv bruttobeloppet så räknas netto + moms ut för 25/12/6 %. Spara och bokför direkt som verifikation.
- **Importera från Stripe** — ladda upp en payout-/balansrapport (CSV) i SEK så skapas försäljningarna (och Stripe-avgifterna, med omvänd skattskyldighet) automatiskt, med förhandsgranskning och dubblettskydd.
- **Momsdeklaration** — rutorna 05/10/11/12/(21/30 vid EU-inköp)/48/49 för aktuell period, plus en filtrerbar **Sammanställning** (aktuell period / helår / allt) med intäkter, kostnader, resultat och egna insättningar/uttag.
- **Export** — CSV för aktuell period (till revisor), CSV för **alla** verifikationer, och **SIE4-fil** (förenklad kontoplan) för import i t.ex. Bokio.
- **Påminnelser** — banner när deadline närmar sig, kalenderexport (.ics) med larm, och valfria webbläsarnotiser.
- **PWA** — installeras på hemskärmen och fungerar offline. Uppdateringar hämtas automatiskt.
- **Moln-synk ("inloggning")** — klistra in en personlig Hugging Face-nyckel (Write) under Inställningar så sparas all data automatiskt i ett privat dataset och synkas mellan enheter. Nyckeln lagras separat från datan.
- **Flytta till annan enhet** — skicka/läs in en fullständig databackup manuellt om du inte vill använda molnsynk.

## Automatisk deploy till Hugging Face

`.github/workflows/deploy-hf.yml` pushar innehållet i `huggingface/` till din Space vid varje push. Engångsinställning i GitHub-repot under **Settings → Secrets and variables → Actions**:

1. Secret `HF_TOKEN` — en Hugging Face-token med Write-behörighet
2. Variable `HF_SPACE` — din Space, t.ex. `dittnamn/moms`

## Lagkrav som byggts in

Varje verifikation fångar det bokföringslagen (5 kap. 7 §) kräver: löpande verifikationsnummer utan luckor, transaktionsdatum, motpart, vad det avser, belopp, momssats och momsbelopp. Rättelser görs enligt god redovisningssed genom nya poster (stornering), aldrig genom att ändra en bokförd post.

## Köra lokalt

Öppna `index.html` i en webbläsare, eller starta en enkel server:

```bash
python3 -m http.server 8000   # besök http://localhost:8000
```

## Viktigt

Det här är ett **personligt hjälpmedel för eget bruk** — inte ett fullständigt dubbel bokföringsprogram och inte kopplat till Skatteverket. SIE-exporten använder en förenklad kontoplan — kontrollera kontona innan import i Bokio eller liknande. Det ersätter inte rådgivning från revisor. Kontrollera alltid exakt deadline och uppgifter hos Skatteverket. Du ansvarar själv för att det du lämnar in är korrekt och i tid.

## Struktur

```
index.html   — appens gränssnitt och alla vyer
styles.css   — design, layout och responsivitet (desktop + mobil)
app.js       — all logik (ledger, moms, deadlines, export, synk)
build-single.cjs — bygger den fristående moms-app.html
huggingface/ — filer redo att laddas upp/deployas till en HF Space
```
