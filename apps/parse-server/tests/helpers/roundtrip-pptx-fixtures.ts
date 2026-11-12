import { createBlankPptx } from '@genoffice/pptx-engine'
import JSZip from 'jszip'
import { readFile } from 'node:fs/promises'

/** Independent source documents for each persisted-model contract. */
export const roundtripFixtures = {
  multiple: async (): Promise<Uint8Array> => {
    /** A multi-slide deck exercises unit indexing and per-slide model round-trips. */
    async function multiSlidePptx(count: number, marker: string): Promise<Uint8Array> {
      const zip = await JSZip.loadAsync(await createBlankPptx())
      zip.file('test-marker.txt', marker)
      const presentation = await zip.file('ppt/presentation.xml')!.async('string')
      const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
      const types = await zip.file('[Content_Types].xml')!.async('string')
      const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
      const slideRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
      let ids = ''
      let relationships = ''
      let overrides = ''
      for (let index = 2; index <= count; index++) {
        ids += `<p:sldId id="${255 + index}" r:id="rId${index + 1}"/>`
        relationships += `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index}.xml"/>`
        overrides += `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
        zip.file(`ppt/slides/slide${index}.xml`, slide)
        zip.file(`ppt/slides/_rels/slide${index}.xml.rels`, slideRels)
      }
      zip.file('ppt/presentation.xml', presentation.replace('</p:sldIdLst>', `${ids}</p:sldIdLst>`))
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        rels.replace('</Relationships>', `${relationships}</Relationships>`),
      )
      zip.file('[Content_Types].xml', types.replace('</Types>', `${overrides}</Types>`))
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    }
    return multiSlidePptx(5, 'roundtrip')
  },
  image: async (): Promise<Uint8Array> => {
    // 1x1 red PNG.
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const PIC =
      '<p:pic><p:nvPicPr><p:cNvPr id="99" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100000" cy="100000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'

    async function deckWithImage(): Promise<Uint8Array> {
      const zip = await JSZip.loadAsync(await createBlankPptx())
      const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
      const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
      const types = await zip.file('[Content_Types].xml')!.async('string')
      zip.file('ppt/media/image1.png', PNG)
      zip.file('ppt/slides/slide1.xml', slide.replace('</p:spTree>', `${PIC}</p:spTree>`))
      zip.file(
        'ppt/slides/_rels/slide1.xml.rels',
        rels.replace(
          '</Relationships>',
          '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>',
        ),
      )
      zip.file(
        '[Content_Types].xml',
        types.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'),
      )
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    }
    return deckWithImage()
  },
  link: async (): Promise<Uint8Array> => {
    const LINK_URL = 'https://example.com/genoffice-roundtrip'
    const SHAPE = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Link shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="400000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rIdLink"/></a:rPr><a:t>roundtrip link</a:t></a:r></a:p></p:txBody></p:sp>`

    async function deckWithLink(): Promise<Uint8Array> {
      const zip = await JSZip.loadAsync(await createBlankPptx())
      const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
      const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
      zip.file('ppt/slides/slide1.xml', slide.replace('</p:spTree>', `${SHAPE}</p:spTree>`))
      zip.file(
        'ppt/slides/_rels/slide1.xml.rels',
        rels.replace(
          '</Relationships>',
          `<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${LINK_URL}" TargetMode="External"/></Relationships>`,
        ),
      )
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    }
    return deckWithLink()
  },
  chart: async (): Promise<Uint8Array> => {
    const CHART = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Series 1</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`

    const FRAME =
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Chart 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="100000" y="100000"/><a:ext cx="3000000" cy="2000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>'

    async function deckWithChart(): Promise<Uint8Array> {
      const zip = await JSZip.loadAsync(await createBlankPptx())
      const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
      const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
      const types = await zip.file('[Content_Types].xml')!.async('string')
      zip.file('ppt/charts/chart1.xml', CHART)
      zip.file('ppt/slides/slide1.xml', slide.replace('</p:spTree>', `${FRAME}</p:spTree>`))
      zip.file(
        'ppt/slides/_rels/slide1.xml.rels',
        rels.replace(
          '</Relationships>',
          '<Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>',
        ),
      )
      zip.file(
        '[Content_Types].xml',
        types.replace(
          '</Types>',
          '<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>',
        ),
      )
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    }
    return deckWithChart()
  },
  chartex: async (): Promise<Uint8Array> => {
    const CHARTEX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><cx:chartData><cx:data id="0"><cx:strDim type="cat"><cx:f>Sheet1!$A$2:$A$3</cx:f><cx:lvl ptCount="2"><cx:pt idx="0">Alpha</cx:pt><cx:pt idx="1">Beta</cx:pt></cx:lvl></cx:strDim><cx:numDim type="val"><cx:f>Sheet1!$B$2:$B$3</cx:f><cx:lvl ptCount="2"><cx:pt idx="0">1</cx:pt><cx:pt idx="1">3</cx:pt></cx:lvl></cx:numDim></cx:data></cx:chartData><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="funnel"><cx:dataId val="0"/></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`

    const FRAME =
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="ChartEx 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="200000" y="200000"/><a:ext cx="3000000" cy="2000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" r:id="rIdChartEx"/></a:graphicData></a:graphic></p:graphicFrame>'

    async function deckWithChartEx(): Promise<Uint8Array> {
      const zip = await JSZip.loadAsync(await createBlankPptx())
      const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
      const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
      const types = await zip.file('[Content_Types].xml')!.async('string')
      zip.file('ppt/charts/chartEx1.xml', CHARTEX)
      zip.file('ppt/slides/slide1.xml', slide.replace('</p:spTree>', FRAME + '</p:spTree>'))
      zip.file(
        'ppt/slides/_rels/slide1.xml.rels',
        rels.replace(
          '</Relationships>',
          '<Relationship Id="rIdChartEx" Type="http://schemas.microsoft.com/office/2014/relationships/chartEx" Target="../charts/chartEx1.xml"/></Relationships>',
        ),
      )
      zip.file(
        '[Content_Types].xml',
        types.replace(
          '</Types>',
          '<Override PartName="/ppt/charts/chartEx1.xml" ContentType="application/vnd.ms-office.chartex+xml"/></Types>',
        ),
      )
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    }
    return deckWithChartEx()
  },
  group: async (): Promise<Uint8Array> => {
    const shape = (id: number, text: string) =>
      '<p:sp><p:nvSpPr><p:cNvPr id="' +
      id +
      '" name="Shape ' +
      id +
      '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="200000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>' +
      text +
      '</a:t></a:r></a:p></p:txBody></p:sp>'
    const GROUP =
      '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="400000"/><a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="400000"/></a:xfrm></p:grpSpPr>' +
      shape(11, 'inside group') +
      shape(12, 'second') +
      '</p:grpSp>'

    async function deckWithGroup(): Promise<Uint8Array> {
      const zip = await JSZip.loadAsync(await createBlankPptx())
      const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
      zip.file('ppt/slides/slide1.xml', slide.replace('</p:spTree>', GROUP + '</p:spTree>'))
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    }
    return deckWithGroup()
  },
  theme: async (): Promise<Uint8Array> => {
    const SHAPE =
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Themed shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="400000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="100000"/></a:schemeClr></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>theme</a:t></a:r></a:p></p:txBody></p:sp>'

    async function deckWithTheme(): Promise<Uint8Array> {
      const zip = await JSZip.loadAsync(await createBlankPptx())
      let slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
      slide = slide.replace('</p:spTree>', SHAPE + '</p:spTree>')
      zip.file('ppt/slides/slide1.xml', slide)
      let theme = await zip.file('ppt/theme/theme1.xml')!.async('string')
      theme = theme.replace(
        /<a:accent1>[\s\S]*?<\/a:accent1>/,
        '<a:accent1><a:srgbClr val="FF00AA"/></a:accent1>',
      )
      zip.file('ppt/theme/theme1.xml', theme)
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    }
    return deckWithTheme()
  },
  animation: async (): Promise<Uint8Array> => {
    const SHAPE =
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Animated shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="400000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>animated</a:t></a:r></a:p></p:txBody></p:sp>'
    const TIMING =
      '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="5" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="2"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'

    async function deckWithAnimation(): Promise<Uint8Array> {
      const zip = await JSZip.loadAsync(await createBlankPptx())
      let slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
      slide = slide.replace('</p:spTree>', `${SHAPE}</p:spTree>`)
      slide = slide.replace('</p:sld>', `${TIMING}</p:sld>`)
      zip.file('ppt/slides/slide1.xml', slide)
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    }
    return deckWithAnimation()
  },
  font: async (): Promise<Uint8Array> => {
    async function deckWithEmbeddedFont(): Promise<Uint8Array> {
      const zip = await JSZip.loadAsync(await createBlankPptx())
      const font = await readFile(
        new URL('../../../../packages/ui/src/fonts/Carlito-Regular.ttf', import.meta.url),
      )
      let presentation = await zip.file('ppt/presentation.xml')!.async('string')
      const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
      zip.file('ppt/fonts/font1.fntdata', font)
      presentation = presentation
        .replace('<p:presentation ', '<p:presentation embedTrueTypeFonts="1" saveSubsetFonts="1" ')
        .replace(
          '</p:presentation>',
          '<p:embeddedFontLst><p:embeddedFont><p:font typeface="RoundtripFont"/><p:regular r:id="rIdFont"/></p:embeddedFont></p:embeddedFontLst></p:presentation>',
        )
      zip.file('ppt/presentation.xml', presentation)
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        rels.replace(
          '</Relationships>',
          '<Relationship Id="rIdFont" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.fntdata"/></Relationships>',
        ),
      )
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    }
    return deckWithEmbeddedFont()
  },
  twoThemes: async (): Promise<Uint8Array> => {
    const SHAPE = (id: number, text: string) =>
      '<p:sp><p:nvSpPr><p:cNvPr id="' +
      id +
      '" name="Shape ' +
      id +
      '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>' +
      text +
      '</a:t></a:r></a:p></p:txBody></p:sp>'

    async function twoThemeDeck(): Promise<Uint8Array> {
      const zip = await JSZip.loadAsync(await createBlankPptx())
      const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string')
      const slide1Rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
      const master = await zip.file('ppt/slideMasters/slideMaster1.xml')!.async('string')
      const masterRels = await zip
        .file('ppt/slideMasters/_rels/slideMaster1.xml.rels')!
        .async('string')
      const layout = await zip.file('ppt/slideLayouts/slideLayout1.xml')!.async('string')
      const layoutRels = await zip
        .file('ppt/slideLayouts/_rels/slideLayout1.xml.rels')!
        .async('string')
      const theme = await zip.file('ppt/theme/theme1.xml')!.async('string')
      const presentation = await zip.file('ppt/presentation.xml')!.async('string')
      const presentationRels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
      const types = await zip.file('[Content_Types].xml')!.async('string')

      // Slide 1 keeps theme1 accent1 (FF00AA), slide 2 gets theme2 accent1 (00AAFF).
      zip.file(
        'ppt/slides/slide1.xml',
        slide1.replace('</p:spTree>', SHAPE(2, 'theme one') + '</p:spTree>'),
      )
      zip.file(
        'ppt/slides/slide2.xml',
        slide1.replace('</p:spTree>', SHAPE(3, 'theme two') + '</p:spTree>'),
      )
      zip.file(
        'ppt/theme/theme1.xml',
        theme.replace(
          /<a:accent1>[\s\S]*?<\/a:accent1>/,
          '<a:accent1><a:srgbClr val="FF00AA"/></a:accent1>',
        ),
      )
      zip.file(
        'ppt/theme/theme2.xml',
        theme.replace(
          /<a:accent1>[\s\S]*?<\/a:accent1>/,
          '<a:accent1><a:srgbClr val="00AAFF"/></a:accent1>',
        ),
      )

      zip.file('ppt/slideMasters/slideMaster2.xml', master)
      zip.file(
        'ppt/slideMasters/_rels/slideMaster2.xml.rels',
        masterRels
          .replace(
            /Target="\.\.\/slideLayouts\/slideLayout1\.xml"/,
            'Target="../slideLayouts/slideLayout2.xml"',
          )
          .replace(/Target="\.\.\/theme\/theme1\.xml"/, 'Target="../theme/theme2.xml"'),
      )
      zip.file('ppt/slideLayouts/slideLayout2.xml', layout)
      zip.file(
        'ppt/slideLayouts/_rels/slideLayout2.xml.rels',
        layoutRels.replace(
          /Target="\.\.\/slideMasters\/slideMaster1\.xml"/,
          'Target="../slideMasters/slideMaster2.xml"',
        ),
      )
      zip.file(
        'ppt/slides/_rels/slide2.xml.rels',
        slide1Rels.replace(
          /Target="\.\.\/slideLayouts\/slideLayout1\.xml"/,
          'Target="../slideLayouts/slideLayout2.xml"',
        ),
      )

      zip.file(
        'ppt/presentation.xml',
        presentation
          .replace(
            '<p:sldMasterIdLst>',
            '<p:sldMasterIdLst><p:sldMasterId id="2147483649" r:id="rIdMaster2"/>',
          )
          .replace('</p:sldIdLst>', '<p:sldId id="257" r:id="rIdSlide2"/></p:sldIdLst>'),
      )
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        presentationRels.replace(
          '</Relationships>',
          '<Relationship Id="rIdMaster2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster2.xml"/>' +
            '<Relationship Id="rIdSlide2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
        ),
      )
      zip.file(
        '[Content_Types].xml',
        types.replace(
          '</Types>',
          '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
            '<Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
            '<Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
            '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>',
        ),
      )
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    }
    return twoThemeDeck()
  },
}
