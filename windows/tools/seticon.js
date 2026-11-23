// Gives "Infinity Timetable.exe" the app icon and name (it starts as Electron's exe).
const ResEdit = require('resedit'); const fs = require('fs');
const [exePath, icoPath, ver] = process.argv.slice(2);
const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const g = groups[0] || { id: 1, lang: 1033 };
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, ico.icons.map(i => i.data));
const v = ver.split('.').map(Number);
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
const lang = (vi.getAllLanguagesForStringValues()[0]) || { lang: 1033, codepage: 1200 };
vi.setStringValues(lang, { ProductName: 'Infinity Timetable', FileDescription: 'Infinity Timetable', CompanyName: 'Infinity Timetable', OriginalFilename: 'Infinity Timetable.exe', InternalName: 'Infinity Timetable', LegalCopyright: 'Infinity Timetable' });
vi.setFileVersion(v[0], v[1], v[2] || 0, 0, lang.lang); vi.setProductVersion(v[0], v[1], v[2] || 0, 0, lang.lang);
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log('icon and name set on', exePath);
