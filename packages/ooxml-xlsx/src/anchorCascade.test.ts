import { describe, expect, it } from 'vitest';
import {
  dropAnchorsInDeletedRows,
  shiftAnchorRow,
  shiftDefinedNamesXml,
  shiftDrawingXmlRows,
} from './anchorCascade';

describe('anchorCascade', () => {
  it('shifts 0-based anchor rows around an insert', () => {
    expect(shiftAnchorRow(0, 2, 0, 1)).toBe(0);
    expect(shiftAnchorRow(1, 2, 0, 1)).toBe(2);
    expect(shiftAnchorRow(5, 2, 0, 1)).toBe(6);
  });

  it('rewrites drawing xml rows and drops deleted-range anchors', () => {
    const xml = `<?xml version="1.0"?>
<wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>0</xdr:col><xdr:row>1</xdr:row></xdr:from>
    <xdr:to><xdr:col>2</xdr:col><xdr:row>3</xdr:row></xdr:to>
  </xdr:twoCellAnchor>
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>0</xdr:col><xdr:row>10</xdr:row></xdr:from>
    <xdr:to><xdr:col>1</xdr:col><xdr:row>11</xdr:row></xdr:to>
  </xdr:twoCellAnchor>
</wsDr>`;
    const deleted = dropAnchorsInDeletedRows(xml, 2, 1);
    expect(deleted).not.toContain('<xdr:row>1</xdr:row>');
    expect(deleted).toContain('<xdr:row>10</xdr:row>');
    const shifted = shiftDrawingXmlRows(deleted, 2, 1, 0);
    expect(shifted).toContain('<xdr:row>9</xdr:row>');
    expect(shifted).toContain('<xdr:row>10</xdr:row>');
  });

  it('shifts defined name A1 refs only for the target sheet', () => {
    const workbook = `<?xml version="1.0"?><workbook><definedNames>
      <definedName name="Sales">Preview!$B$2:$B$10</definedName>
      <definedName name="Total">Preview!B5</definedName>
      <definedName name="Other">Other!$A$1:$A$3</definedName>
      <definedName name="Local" localSheetId="0">$C$2</definedName>
    </definedNames></workbook>`;
    const next = shiftDefinedNamesXml(workbook, 'Preview', 0, 2, 0, 2);
    expect(next).toContain('Preview!$B$4:$B$12');
    expect(next).toContain('Preview!B7');
    expect(next).toContain('Other!$A$1:$A$3');
    expect(next).toContain('localSheetId="0">$C$4</definedName>');
  });
});
