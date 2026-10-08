# Product Pelican metafield prompts for Motto

Paste each block into AI Prompts → Metafields for the field named in its heading.

The prompts refer to context metafields by name. Those names must match the metafield definition names Mouse writes to, because Pelican labels each context value with its definition name:

- Source: Identity
- Source: Fabric
- Source: Sizing
- Tech pack: Design
- Tech pack: Construction
- Tech pack: BOM
- Tech pack: Care label
- Tech pack: Measurements

Option values (Fabric Weight, Fit Type, Stretch Rating, Sizing Advice, Size Set) are written as they exist in Airtable today, not as Motto's documents spell them.

Pelican cuts a field prompt off at 2,000 characters without warning. Every prompt below fits, and its length is given beside it.

## Colour Group

Target: `custom.colour`. 1,161 characters. Blocked until Pelican can write a list of metaobject references.

```
Choose the Colour Groups a customer would filter by to find this product. Answer with one or more of these exact values, separated by commas, and nothing else: Animal Print, Black, Blue, Brown, Green, Neutral, Orange, Pink, Print, Purple, Red, White, Yellow, Denim, Gold, Silver, Grey, Stripe.
Start from REX Col Name in "Source: Identity" and the colour word in the title, then let the photos decide. Judge the garment only, not the styling or background. Use the first rule that fits:
1. Denim: Denim only, whatever the wash colour.
2. Animal print: Animal Print only, no base colour.
3. Stripes or checks: Stripe plus the one dominant base colour (navy/white stripe = Blue, Stripe).
4. Any other print: Print plus the one dominant base colour (pink floral = Pink, Print).
5. Sequins or embellishment heavy enough that the garment no longer reads as plain: Print plus the base colour (black sequin top = Black, Print).
6. Plain: its colour, or two colours where the shade sits between them (red-orange = Red, Orange; pink-purple = Pink, Purple).
A "/" in the colour name often means a print, stripe or multi-colour design, so check the photos before deciding.
```

## Features

Target: `custom.features_fit` (multi-line text). 1,293 characters.

```
List this garment's design, silhouette and construction features, one per line, each starting with "• ". Say what the garment is, not why to buy it.
Take the facts from "Tech pack: Design", "Tech pack: Construction" and "Tech pack: BOM". The photos confirm shape, proportion and visible details, and may add a feature that is plainly visible, but never hidden construction such as lining, internal elastic or hidden pockets. Fit Type, Category and Sub-Category only help you read the silhouette and garment type.
Order, skipping what does not apply: silhouette; length; neckline or collar; sleeves and shoulders; waist or bodice; closures; pockets (functional or decorative, if stated); lining; trims and details; adjustable or removable parts. Merge related details into one bullet. Name a fabric treatment only when it is a visible design feature (sequins, faux leather, vintage wash, metallic finish).
Leave out benefits, styling and occasion ideas, sizing advice, stretch, fibre content, handfeel, fabric weight, the main colour and any measurement in centimetres.
Example:
• Relaxed boyfriend silhouette
• Classic blazer lapels and collar
• Single-breasted design with matte metal button
• Full-length sleeves with double contrast stripe detail
• Front flap pockets
• Fully lined in satin
```

## Fabric & Feel

Target: `custom.fabric_and_feel` (multi-line text). 1,553 characters.

```
Write one short paragraph about the fabric from "Source: Fabric", then a care line on a new line. Keep the tone clear, factual and natural, with a little warmth and no sales language or exaggerated claims.
Paragraph: give Fiber Comp % exactly as written, then how the fabric feels and presents, from Handfeel & Finish, in natural customer language. You may blend or soften its descriptors ("Silky, Smooth, Fluid, Subtle Sheen" = "a silky, smooth feel with a fluid drape and subtle sheen") but not add a quality they do not support. Work in Fabric Weight as very lightweight, lightweight, mid-weight, heavyweight or extra heavyweight (for Very Heavy); light does not mean thin or sheer, and heavy does not mean stiff. Leave stretch to the Stretch field unless a brief mention helps describe the fabric. Fabric Tag is background only and never appears in the copy. Skip any part whose data is missing.
Care line, from "Tech pack: Care label", in one of these forms:
How to love me: Machine washable
How to love me: Hand wash only to [short reason]
Any machine wash, cold or gentle included, is machine washable. Give a hand wash reason only if the data supports one (delicate trims, embellishment, fabric finish, garment shape); otherwise end at "Hand wash only". Leave out the label's own wording and its temperature, drying and ironing detail. No care label, or dry clean only: no care line.
Example:
Made from 100% Viscose, this lightweight fabric has a soft, fluid feel with a subtle sheen.
How to love me: Hand wash only to preserve the fabric finish
```

## Stretch

Target: `custom.stretch` (multi-line text). 1,317 characters.

```
Write up to three sentences as one paragraph. Keep the tone clear, factual and natural, with a little warmth and no sales language or exaggerated claims.
Sentence 1 is fixed by Stretch Rating in "Source: Fabric". Copy the matching sentence exactly:
0 – No Stretch: This style is made from a fabric with no stretch.
1 – Some Stretch: This style is made from a fabric with a little stretch.
2 – Stretchy: This style is made from a stretchy fabric.
3 – Very Stretchy: This style is made from a super stretchy fabric.
If the rating is N/A or missing, answer "" and write nothing else.
Sentence 2: what that means in wear (movement, give, how the fabric feels), drawing on Handfeel & Finish and Fiber Comp %. It adds a wearing benefit rather than repeating sentence 1, and never claims more stretch than the rating gives, whatever the fibres are.
Sentence 3, only if "Tech pack: Construction" or a photo clearly shows a feature that adds give or adjustability (elasticated waist, shirring, smocking, rib or stretch panels, elastic cuffs): one short sentence on its benefit, without suggesting the fabric itself stretches more.
Example:
This style is made from a fabric with no stretch. Its soft, fluid feel allows the style to move comfortably when worn. The elasticated waistband adds extra flexibility through the waist.
```

## Fit type

Target: a new single-line text field named Fit type. Its key isn't created yet; `custom.fit_type` is assumed. 1,370 characters.

```
Write the fit statement for this product as plain sentences on one line, from "Source: Sizing": size choice, then intended fit, then anything extra.
- Size Set 8-20: Sizing Advice with the Fit Type value, e.g. "True to size. Choose your usual Motto size for the intended relaxed fit." or "If you are between sizes, choose the smaller size. This style has a relaxed fit."
- XS-XL: "This style has a flexible fit, so there's some freedom in which size you choose based on whether you prefer a more relaxed or closer fit." Then a guide to the sizes in ACTIVE SIZES as one sentence, e.g. "As a guide: S suits sizes 8–10, M suits size 12 and L suits sizes 14–16." XL suits sizes 18–20. Leave XS out.
- Combined: "This style is adjustable and designed to fit across a range of sizes." Then the same kind of guide: S/M suits sizes 8–12; M/L suits sizes 14–18. Leave L/XL out.
- One Size or N/A: "One Size" for jewellery and armbands; "" for bags; for belts, how they fit or adjust, from "Tech pack: Construction".
A customer-relevant Sizing / Description Note adds to or replaces this, and leads when it is the main instruction. When Sizing Advice is "Special Sizing Note", the note is the instruction. "Tech pack: Construction" and the photos may add where the garment fits (fitted waist, relaxed leg) but never override Sizing Advice.
No line breaks, bullets or measurements.
```

## Measurements

Target: `custom.fit_and_measurements` (multi-line text). 1,213 characters.

```
List this product's measurements from "Tech pack: Measurements". Each line there is already worked out, so keep its numbers and sizes as given, give it a customer label and drop any bracketed note. Take these points, in this order:
- Pants, shorts: waist; waist fully stretched; hip; in-leg; out-leg; front rise; back rise.
- Skirt: waist; hip; length from waist to hem.
- Dress: bust; waist; hip; length from shoulder to hem; sleeve length.
- Tops, jackets: bust; waist if shaped; hem; length from shoulder to hem; sleeve length.
- Belt: total length; width; smallest and largest wearable circumference.
- Jewellery: chain, bracelet, drop or extension length; width where useful.
- Bag: width; height; depth; strap or handle length.
For an uneven hem give the shortest and longest length. For elastic say "unstretched" and "fully stretched". Add another point only when it clearly helps a customer judge fit, length or scale, such as shoulder width on a tailored jacket. Leave out production points such as neck, armhole and collar.
Format:
Measurements:
• Waist circumference: 74cm for Size 8, increasing by 5cm per size
• In-leg length: 73cm for Size 8, consistent across sizes
With no measurements, answer "".
```

## General Metafield Rules

Motto's sixth document has no prompt of its own, because Pelican has nowhere to put an instruction that applies to every field. This is where each part of it went.

| Section | Where it went |
| --- | --- |
| 1 to 4: Airtable fields, tech pack sections, product images | Mouse. It stages the Airtable fields the five field documents use, with both fallbacks (Description, COLOURWAY), and reads the tech pack into the five sections listed at the top, ignoring the rest. Fibre composition is never taken from the tech pack. Each prompt says how it may use the photos. |
| 2: BOX#, SKU, PATTERN#, Supplier, Fabric Code, OLD ONLINE DESC | Not staged. No field document uses them. |
| 5: Metafield independence | Every prompt reads the staged source fields. None reads what another prompt wrote. |
| 6 and 7: Source priority, missing data | No rules of their own. Both point back to each field's document. |
| 8: Colourway consistency | Not met. See below. |
| 9: Writing style | One sentence at the start of Fabric & Feel and Stretch, the two prompts that write free prose. Features already rules out benefit and marketing wording, and Fit type and Measurements are mostly fixed wording. |

Colourway consistency can't be met by a prompt. Pelican writes each product on its own, with that product's photos and a little randomness, so two colourways of one style can come back worded differently. The fixed wording (Stretch sentence 1, the fit statements, the measurement lines) will match across colourways. The free prose (Features bullets, the Fabric & Feel paragraph, Stretch sentences 2 and 3) may not. Matching them would mean writing a style once and copying the result to its other colourways, which is a feature for Mouse or Pelican.

## What was left out of Motto's documents

| Left out | Why |
| --- | --- |
| "Relevant Inputs", "Mapping Sources", "Sources Explained" | Mouse already reads Airtable and the tech pack and stages them as the eight fields listed at the top. Each prompt names the field it needs. |
| Fit & Measurements: source rule, base-size rule, grade rule, units and decimals | Mouse works these out. Each line reaches Pelican as `WAIST: 74cm for Size 8, +5cm per size`, so the prompt only picks, relabels and orders. |
| Features: what to pull from the tech pack, avoiding production terms | Mouse's tech pack reading keeps only customer-visible construction, visible materials and descriptions of the sketches. |
| Fabric & Feel: finding the care label, not inferring composition from another field | The care label arrives already extracted, and the tech pack text carries no fibre percentages. |
| "Do not guess", "do not invent", "Missing Data" | Pelican tells the model this around every field: use the product data only, and leave a field blank when it can't be determined. |
| Purpose sections, "General Rule" and logic summaries, Fit Type definitions, long example lists | Restatements or common knowledge. Each prompt keeps one worked example. |
| Features: "do not copy features from another style in the same Sub-Category" | Pelican writes one product at a time and never sees another style. |

## Where the prompts differ from Motto's documents

1. No bold. The target fields are plain text, so "How to love me:", "Measurements:" and "As a guide:" are written without asterisks.
2. "Flag for review" when XS or L/XL is active. Pelican has no way to flag, so the prompt gives no size conversion for those sizes and says nothing more.
3. Fit & Measurements is two fields. The fit statement goes to Fit type and the list to Measurements. Fit type is single-line text, which can't hold line breaks, so the XS–XL and Combined size guide is one sentence ("As a guide: S suits sizes 8–10, M suits size 12 and L suits sizes 14–16.") in place of the bulleted list in Motto's document.
4. Option names follow Airtable: Very Heavy (the documents say Extra Heavy), Tight/Fitted, Regular/Standard.
5. Care line: any machine wash counts as "Machine washable", and a dry-clean-only label gets no care line. The documents cover neither case.

## Limits in Pelican that still apply

- Pelican passes the model at most 1,000 characters of each context metafield and 2,500 across all of them. One that doesn't fit in what is left is dropped whole. The eight fields above will not fit in 2,500, so some tech pack sections won't reach the model until that limit is raised.