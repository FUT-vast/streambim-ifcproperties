# StreamBIM – IFC-egenskaper

Widget som visar vilka **property sets och egenskaper** som finns i projektets IFC-filer.

1. Välj en eller flera IFC-filer i flervalsfältet högst upp.
2. Listan visar alla property sets i de valda filerna. Klicka på en rad för att se egenskaperna.
3. Klicka på en egenskap för att se alla unika värden och hur många objekt som har respektive värde.

När flera filer är valda får varje fil ett färgat nummer (1, 2, 3 …). Numret syns på varje
property set och varje egenskap: ifyllt betyder att datan finns i filen, streckat att den saknas.
I värderutan finns en kolumn per fil.

## Kör

```bash
python server.py          # serverar ./public på http://localhost:3000/
```

Öppna projektet i StreamBIM med widgeten `localhost`:

```
https://app.streambim.com/webapp/default/#/viewer/objectinfo/widget/localhost?projectId=<id>
```

Om du öppnar http://localhost:3000/ direkt i webbläsaren körs widgeten mot testdata (`public/mock.js`).

## Så fungerar det

- IFC-filerna hämtas med REST: `ifc-files?filter[building]=…` (dokument-id och lager, filer
  markerade för borttagning hoppas över) och filnamnet från `documents/{id}`.
- Filens objekt hittas med `findObjects` och regeln `@Document Id = <dokument-id>`. Ger den inga
  objekt och filen ensam utgör ett lager används `@Group Layer` i stället.
- Egenskaperna läses med REST: en sökning (`POST ifc-searches`) och sedan
  `GET ifc-searches/export/json?fieldUnion=true` **utan** `fieldNames`, sida för sida. Det är samma
  anrop som `getObjectInfoForSearch` gör, och det ger alla kolumner `PsetNamn~Egenskap` för varje
  objekt. Om en sida misslyckas eller tar för lång tid halveras sidstorleken (1 000 ned till 50).
- Om exporten inte fungerar provas `getObjectInfo` för varje objekt (16 åt gången). Den ger bara
  objektens egna attribut, inte property sets, så om inga property sets kommer fram visas ett fel i
  stället för en ofullständig lista.
- Kolumner utan `~` (t.ex. `Name`, `IFC Type`) visas som *Objektattribut*.
- **IfcProject och IfcSite** kommer inte med i sökningen per fil. De hämtas separat:
  `valuesForObjectProperty('@kind')` ger IFC-klasserna och `findObjects` på `@kind = Project/Site`
  ger noderna. `getObjectInfo` används bara för att se vilken fil noden hör till (`@Document Id`).
  Nodernas property sets hämtas med REST-exporten, med en sökning på deras GUID:er.
  De visas överst med en etikett (*IfcProject* / *IfcSite*). Om exporten per fil redan innehåller
  dem flyttas de dit och räknas inte två gånger. Går de inte att läsa visas en varning.
- Resultatet räknas ihop i webbläsaren och sparas per fil tills widgeten laddas om.
- Alla anrop har en tidsgräns, och förloppet visar hur långt inläsningen kommit och hur lång tid som gått.

## Begränsningar

- Bara aktuell byggnad.
- Tomma värden räknas inte som värden.
- Värderutan visar de 1 000 vanligaste värdena. Använd filterfältet för att hitta övriga.

Källa: [streambim-api-docs](https://github.com/jonatanjacobsson/streambim-api-docs) (inofficiell).
