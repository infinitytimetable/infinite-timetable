import re,sys
s=open('/home/claude/exam/index.html').read();v=re.search(r"VERSION='([0-9.]+)'",s).group(1)
one=s.replace('<link rel="stylesheet" href="fonts.css">','<style>\n'+open('/home/claude/exam/fonts.css').read()+'</style>',1).replace('<script src="logos.js"></script>','<script>\n'+open('/home/claude/exam/logos.js').read()+'</script>',1)
one=one.replace('<title>Exam Display</title>','<title>Exam Display</title>\n<meta name="theme-color" content="#0d1b33">\n<!-- Exam Display '+v+': one self-contained file, works offline. Open it in Chromium or Chrome. Fonts: SIL OFL 1.1 / Apache 2.0 / Bitstream Vera licences. -->',1)
open('/home/claude/out/ExamDisplay-'+v+'.html','w').write(one);print('ExamDisplay-'+v+'.html')
