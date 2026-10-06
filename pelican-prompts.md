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

## Colour Group

Target: `custom.colour`. Blocked until Pelican can write a list of metaobject references.

```
Assign every Colour Group that would help a customer find this product in the colour filter. Answer with one or more of these exact values, separated by commas, and nothing else: Animal Print, Black, Blue, Brown, Green, Neutral, Orange, Pink, Print, Purple, Red, White, Yellow, Denim, Gold, Silver, Grey, Stripe.
Start from REX Col Name in "Source: Identity" and the first word of the product title, then let the photos decide: the actual colour, the dominant base colour, and whether the garment is plain, printed, striped, checked, animal print, denim, sequined or embellished. Where the photos are clearer than the name, follow the photos. Judge the garment only, not the model's other clothing or the background.
Apply the first rule that fits:
1. Denim: answer Denim only. Do not add the wash colour.
2. Animal print (leopard, zebra): answer Animal Print only. No base colour.
3. Stripes or checks: Stripe plus the one dominant base colour (navy/white stripe = Blue, Stripe; brown check = Brown, Stripe).
4. Any other print: Print plus the one dominant base colour (pink floral = Pink, Print). Never list every colour in a print.
5. Sequins or heavy embellishment that make the garment read as not plain: Print plus the base colour (black sequin top = Black, Print).
6. Plain colour: that colour. If the shade genuinely sits between two groups, give both (red-orange = Red, Orange; pink-purple = Pink, Purple; blue-green = Blue, Green).
A "/" in the colour name suggests a print, stripe or multi-colour design. Check the photos before deciding; the "/" does not decide the group.
If no photo is attached and the colour name is unclear, answer "".
```

## Features

Target: `custom.features_fit` (multi-line text).

```
List the garment's actual design, silhouette and construction features as bullets, one per line, each starting with "• ". Say what the garment is, not why to buy it.
Sources: "Tech pack: Design", "Tech pack: Construction" and "Tech pack: BOM" are the main factual source. The photos confirm silhouette, proportion, pocket placement and visible trims, and may add a feature that is clearly visible and unambiguous. Never infer hidden construction from a photo: lining, internal elastic, hidden pockets, internal closures. Fit Type, Category and Sub-Category in the Source fields are context for silhouette and garment type only. Never copy features from another style in the same Sub-Category.
Order, skipping what does not apply: silhouette or overall shape; length or proportion; neckline or collar; sleeves or shoulders; waist or bodice construction; closures; pockets (say functional or decorative if known); lining; trims and design details; adjustable or removable elements. Include a fabric treatment only when it is a visible design feature: sequins, faux leather, vintage wash, chiffon overlay, metallic finish, placement print.
Combine closely related details into one bullet ("Full-length sleeves with double contrast stripe detail"). There is no fixed number of bullets. Use everyday words instead of production terms. Describe length in words, never in centimetres.
Leave out: comfort, benefit, versatility, occasion or styling claims ("perfect for", "easy to wear"); fit or sizing advice; stretch; fibre composition; handfeel; fabric weight; the garment's main colour.
If a feature is not confidently supported, omit it. If nothing is supported, answer "".
Example:
• Relaxed boyfriend silhouette
• Classic blazer lapels and collar
• Single-breasted design with matte metal button
• Full-length sleeves with double contrast stripe detail
• Front flap pockets
• Fully lined in satin
```

## Fabric & Feel

Target: `custom.fabric_and_feel` (multi-line text).

```
Write one short paragraph about the fabric, then a care line on a new line.
Paragraph, from "Source: Fabric" only: fibre composition, handfeel, drape or structure or finish, and weight, in natural customer language. Do not force every input in if it makes the sentence clunky.
- Fiber Comp %: copy the fibres and percentages exactly. Never change, round, substitute or infer them.
- Handfeel & Finish: the main source for how the fabric feels and presents. You may combine or soften its descriptors ("Silky, Smooth, Fluid, Subtle Sheen" becomes "a silky, smooth feel with a fluid drape and subtle sheen") but never add a quality it does not support.
- Fabric Weight: Very Light = very lightweight; Light = lightweight; Mid = mid-weight; Heavy = heavyweight; Very Heavy = extra heavyweight. Lightweight does not mean thin or sheer, and heavyweight does not mean stiff.
- Stretch Rating: mention briefly only if it helps describe the fabric. Never infer stretch from fibres.
- Fabric Tag: internal context only. Never write it in the copy.
Care line, from "Tech pack: Care label" only, in exactly one of these forms:
How to love me: Machine washable
How to love me: Hand wash only to [short reason]
A label that says to wash in cold water and does not say hand wash means Machine washable. Give a hand wash reason only when the data supports one (delicate trims, embellishment, the fabric finish, the garment shape); otherwise write "How to love me: Hand wash only". Any other label (dry clean, do not wash): leave the care line out. Never copy the label wording or add temperature, detergent, laundry bag, bleach, drying or ironing detail.
Missing data: no Fiber Comp % = no composition; no Fabric Weight = no weight wording; no Handfeel & Finish = no texture or finish; no care label = no care line. If nothing remains, answer "".
Example:
Made from 100% Viscose, this lightweight fabric has a soft, fluid feel with a subtle sheen.
How to love me: Hand wash only to preserve the fabric finish
```

## Stretch

Target: `custom.stretch` (multi-line text).

```
Write up to three sentences in one paragraph.
Sentence 1 is fixed by Stretch Rating in "Source: Fabric". Copy the matching sentence exactly:
0 – No Stretch = This style is made from a fabric with no stretch.
1 – Some Stretch = This style is made from a fabric with a little stretch.
2 – Stretchy = This style is made from a stretchy fabric.
3 – Very Stretchy = This style is made from a super stretchy fabric.
If Stretch Rating is empty or N/A, answer "" and write nothing else.
Sentence 2: what that means when worn (movement, give, flexibility, how the fabric feels in wear), using Handfeel & Finish and Fiber Comp % as supporting context. It must add a wearing benefit, not repeat sentence 1. Never contradict the rating, never use the fibres to claim extra stretch, and claim nothing those three fields do not support. If Handfeel & Finish is empty, keep to what the rating alone supports.
Sentence 3, optional: only when "Tech pack: Construction" shows a feature that adds give or adjustability, such as an elasticated waistband, an elasticated back waist, shirring, smocking, an elasticated neckline, rib or stretch panels, elastic cuffs or stretch inserts. A photo counts only where the feature is clearly visible. Write one short sentence on the benefit ("The elasticated waistband adds extra flexibility through the waist."). It must not suggest the fabric itself stretches more. No such feature = no third sentence.
Plain customer language, no production terms.
Example:
This style is made from a fabric with no stretch. Its soft, fluid feel allows the style to move comfortably when worn. The elasticated waistband adds extra flexibility through the waist.
```

## Fit & Measurements

Target: `custom.fit_and_measurements` (multi-line text). At about 3,900 characters it is longer than Pelican's current 2,000-character limit for a field prompt, so it will be cut off until that limit is raised.

```
Write a fit statement, then one blank line, then a measurements list. Plain text. No heading before the fit statement.

FIT STATEMENT, from "Source: Sizing": Size Set, ACTIVE SIZES, Sizing Advice, Fit Type, Sizing / Description Notes. Default order: size choice, intended fit, extra sizing information. No fixed length.
Always read Sizing / Description Notes. A customer-relevant note may add to, qualify or replace the standard wording, and goes first when it is the most important instruction. When Sizing Advice is "Special Sizing Note", the note is the instruction. Ignore a note that is unclear or internal.
"Tech pack: Construction" and the photos may add where the garment fits (fitted waist, relaxed leg, oversized sleeve). They never override Sizing Advice.
Fit Type: Tight/Fitted = sits close to or contours the body; Slim = follows the body without being tight; Regular/Standard = neither close nor loose; Relaxed = intentionally roomier; Oversized = deliberately loose.
By Size Set:
- 8-20: lead with Sizing Advice, combined with Fit Type. "True to size. Choose your usual Motto size for the intended relaxed fit." / "If you are between sizes, choose the smaller size. This style has a relaxed fit." / "If you are between sizes, choose the larger size. This style has a slim fit."
- XS-XL: "This style has a flexible fit, so there's some freedom in which size you choose based on whether you prefer a more relaxed or closer fit." Then "As a guide:" and one line per size in ACTIVE SIZES only: "• S suits sizes 8–10", "• M suits size 12", "• L suits sizes 14–16", "• XL suits sizes 18–20". Never give a conversion for XS.
- Combined: "This style is adjustable and designed to fit across a range of sizes." Then "As a guide:" and, for active sizes only: "• S/M suits sizes 8–12", "• M/L suits sizes 14–18". Never give a conversion for L/XL.
- One Size or N/A: jewellery and armbands = "One Size". Bags = no fit statement. Belts = describe fit or adjustability from Construction. Anything else = a fit statement only if the data supports one.

MEASUREMENTS, from "Tech pack: Measurements" only. Copy every number exactly as given. Never calculate, convert or estimate, and never take a measurement from a photo. Format:
Measurements:
• Waist circumference: 74cm for Size 8, increasing by 5cm per size
• In-leg length: 73cm for Size 8, consistent across sizes
Combined sizes go on one line ("• Total belt length: 102cm for S/M and 118cm for M/L"). One-size products have no size ("• Chain length: 48cm").
Use full customer labels (Bust, Waist, Hip or Hem circumference) and say where a length is measured from. For elastic, say "unstretched" and "fully stretched". Include these points, in this order, when present:
- Pant, jean, short: waist; waist fully stretched; hip; in-leg; out-leg; front rise; back rise.
- Skirt: waist; hip; length from waist to hem (shortest and longest if the hem is uneven).
- Dress: bust; waist; hip; length from shoulder to hem (shortest and longest if uneven); sleeve length.
- Top, shirt, knitwear, t-shirt, cami: bust; waist only if the garment is shaped; hem; length from shoulder to hem (front and back if they differ); sleeve length.
- Blazer, jacket: bust; waist if useful; hem; length from shoulder to hem; sleeve length; shoulder width if it matters to fit.
- Belt: total length; width; minimum and maximum wearable circumference.
- Jewellery: chain, drop, bracelet or extension length; earring drop and width; brooch height and width.
- Bag: width; height; depth; strap or handle length.
Add another measurement only when it clearly helps the customer judge fit, length or scale. Leave out production measurements such as neck, armhole, tab, collar and yoke.
No measurements = fit statement only. No fit statement = start at "Measurements:". Never put a measurement in the fit statement. No closing disclaimer.
```
