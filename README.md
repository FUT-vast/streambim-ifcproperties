# StreamBIM – IFC-egenskaper

Widget som visar vilka **property sets och egenskaper** som finns i projektets IFC-filer.

1. Välj en eller flera IFC-filer i flervalsfältet högst upp.
2. Listan visar alla property sets i de valda filerna. Märket före namnet visar var de ligger:
   *IfcProject*, *IfcSite* eller *IfcElement* (objekt i modellen). *Attribut* är nodens egna
   attribut (Name, IFC Type …). Klicka på en rad för att se egenskaperna.
3. Varje egenskap visas med sitt namn och sina värden (separerade med `|`, vanligast först).
   Klicka på **"N värden ›"** för att se alla unika värden och hur många objekt som har respektive värde.

### Markera i modellen

- Klicka på en **egenskaps namn**: StreamBIM markerar alla objekt som har egenskapen i de valda filerna.
- Klicka på ett **värde** i värderutan: StreamBIM markerar objekten som har just det värdet.
- Det går att ha flera markeringar samtidigt (de läggs ihop). Klicka igen för att avmarkera.
  Raden ovanför listan visar antal markerade objekt, *Zooma till* och *Rensa markering*.
- Bara modellerade objekt (*IfcElement*) kan markeras, inte IfcProject/IfcSite.
- Så görs det: reglerna (för varje vald fil `@Document Id` OCH egenskapen med `hasValue`, eller
  `=` värde) skickas som REST-sökning (`POST ifc-searches`), och GUID-kolumnen exporteras för att
  få träffarna. Sedan visas de med `applyObjectSearch` (StreamBIMs sökmarkering). Svarar den inte
  inom 15 s färgas objekten i stället med `colorCodeObjects` (i standardvarianten av StreamBIM
  ritas inte färgen, objekten visas i sökgrönt). *Zooma till* (`zoomToSearchResult`) visas vid
  sökmarkering. Snabba klick i följd ger en enda sökning.
- Belastning (enligt AGENTS.md, *Rate limiting and fair use*): högst 4 anrop samtidigt,
  omförsök efter en paus (1 s, 2 s, 4 s …), och projekt, filer, etiketter samt IfcProject/IfcSite
  hämtas en gång per session.
  (Widget-API:ts `findObjects`/`applyObjectSearch` kan hänga utan svar på en sökning servern inte
  godtar, därför görs sökningen först via REST.)
- Markeringen rensas när filvalet ändras.

När flera filer är valda får varje fil ett färgat nummer (1, 2, 3 …). Numret syns på varje
property set och varje egenskap: ifyllt betyder att datan finns i filen, streckat att den saknas.
I värderutan finns en kolumn per fil.

### Filtrera fillistan

Bara `.ifc`-filer visas. Under **Filter** i fillistan går det att begränsa listan på:

- **Senast ändrad** (dokumentets `last-modified`, inte uppladdningsdatum). *Nyare än* = ändrad
  den dagen eller senare, *Äldre än* = ändrad före den dagen. Filer utan datum döljs när ett
  datumfilter är aktivt.
- **Lager**: filen ligger i något av de valda lagren (`M~E` räknas som både M och E).
- **Etiketter**, grupperade som i StreamBIMs dokumentpanel: minst en av de valda etiketterna
  inom varje grupp, och alla grupper med val måste stämma.

*Markera alla* och *Avmarkera* gäller de filer som syns i listan.

## Publicering

Widgeten är statiska filer i `public/` och har inga beroenden eller byggsteg. Den ska hostas som
en Cloudflare Worker (statiska filer), och widgetens URL vitlistas av Rendra (support@rendra.io),
som också slår på **WIDGET** för projektet.

`public/_headers` sätter säkerhetsheadrarna (Cloudflare läser filen för statiska filer i Workers
och Pages):

- `Content-Security-Policy`: skript bara från widgeten själv och den versionslåsta penpal-filen
  på cdn.jsdelivr.net, och `frame-ancestors` så att bara StreamBIM får bädda in widgeten.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.

Kontrollera efter publiceringen att headrarna kommer med (t.ex. i webbläsarens nätverksflik).
Hostas widgeten någon annanstans måste samma headrar sättas där.

Öppnas widgetens URL direkt i webbläsaren, utanför StreamBIM, körs den mot testdata
(`public/mock.js`). Ingen riktig projektdata finns i testdatan.

## Så fungerar det

- IFC-filerna hämtas med REST: `ifc-files?filter[building]=…` (dokument-id och lager, filer
  markerade för borttagning hoppas över). Filnamn, `last-modified` och etiketter kommer från
  `documents/{id}`, etikettnamn och grupper från `document-labels` och `label-groups`.
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
  ger noderna. Varken `getObjectInfo` eller exporten innehåller deras property sets, så varje nod
  läses som REST-post: `GET /v2/ifc-objects/{guid}?building=…`. Där finns `@Document Id` (vilken
  fil noden hör till) och property sets i `groups`. Serverns egna grupper `Custom` (skapad/ändrad
  av, med e-postadresser) och `Geometry` visas inte.
  De visas överst med en etikett (*IfcProject* / *IfcSite*). Om exporten per fil redan innehåller
  dem flyttas de dit och räknas inte två gånger. Går de inte att läsa visas en varning.
- Resultatet räknas ihop i webbläsaren och sparas per fil tills widgeten laddas om.
- Alla anrop har en tidsgräns, och förloppet visar hur långt inläsningen kommit och hur lång tid som gått.

## Begränsningar

- Bara aktuell byggnad.
- Tomma värden räknas inte som värden.
- Värderutan visar de 1 000 vanligaste värdena. Använd filterfältet för att hitta övriga.

Källa: [streambim-api-docs](https://github.com/jonatanjacobsson/streambim-api-docs) (inofficiell).
