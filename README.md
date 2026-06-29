# Moms — enkel momskoll

Ett **enkelt och tydligt** personligt verktyg för att hålla koll på din momsredovisning: dina kvitton, dina summor och dina deadlines. Byggt med ren HTML, CSS och JavaScript — inget byggsteg, inga beroenden, inget konto. All data sparas **lokalt i din webbläsare** (localStorage) och skickas aldrig någonstans.

Designen är inspirerad av moderna Framer-mallar (vibrant + oma-voxia) — ljus, lugn och energisk på samma gång, optimerad för att vara lätt att läsa.

## Vad den gör

- **Översikt** — nästa deadline med nedräkning, hur mycket moms du ska betala eller få tillbaka, och en checklista över vad du behöver göra innan deadline.
- **Kvitton** — lägg in inköp och försäljning. **Momsen räknas ut automatiskt** (25/12/6/0 %), inkl. eller exkl. moms. Bifoga bild på kvittot och egen fri text.
- **Momskalkylator** — skriv t.ex. "Såld vara 2000 kr exkl. moms" så räknas exkl/moms/inkl ut direkt. Spara uträkningen, och bokför den som kvitto med ett klick om du vill att den ska räknas in i momsen.
- **Momsdeklaration** — summorna förs automatiskt till rätt rutor (05, 10, 11, 12, 48, 49) så du bara skriver av dem hos Skatteverket. Exportera underlag som CSV.
- **Anteckningar** — fri text som sparas automatiskt.
- **Inställningar** — namn, org.nr och hur ofta du redovisar (kvartal/månad/helår). Säkerhetskopiera och återställ all data.

## Lagkrav som byggts in

Varje kvitto fångar det en verifikation enligt bokföringslagen (5 kap. 7 §) ska innehålla: löpande verifikationsnummer, transaktionsdatum, motpart, vad det avser, belopp, momssats och momsbelopp, samt möjlighet att bifoga själva kvittot.

## Köra lokalt

Öppna `index.html` i en webbläsare, eller starta en enkel server:

```bash
python3 -m http.server 8000   # besök http://localhost:8000
```

## Viktigt

Det här är ett **personligt hjälpmedel för eget bruk** — inte officiell bokföring och inte kopplat till Skatteverket. Det ersätter inte bokföringsprogram eller rådgivning från revisor. Kontrollera alltid exakt deadline och uppgifter hos Skatteverket. Du ansvarar själv för att det du lämnar in är korrekt och i tid.

## Struktur

```
index.html   — appens gränssnitt och alla vyer
styles.css   — design, layout och responsivitet (desktop + mobil)
app.js       — all logik (data, moms, deadlines, kvitton, export)
```
