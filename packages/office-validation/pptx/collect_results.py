from pathlib import Path
import json, hashlib
ROOT=Path(__file__).resolve().parent
sdk=json.loads((ROOT/'sdk-results.json').read_text());sem=json.loads((ROOT/'semantic-results.json').read_text());m=json.loads((ROOT/'manifest.json').read_text())
result={'issue':118,'package':'F03','format':'pptx','status':'limited','runtime':sdk['runtime'],'fixture_versions':m['versions'],'license':sdk['license'],'samples':{},'external_reopen':'pending_main_agent','browser_edit':'pending_main_agent','limitations':['备注与notes master在两条无修改API链中均丢失','图表clustered分组改写为standard，python-pptx图表类型解析失败','动态日期/页码字段及母版五级正文占位符示例未保留','未验证PowerPoint或LibreOffice视觉保真；本报告不等于F06交付']}
for kind,r in sdk['samples'].items():
 rows={}
 for mode in ['product-unchanged','aggregate-unchanged','edited']:
  v=json.loads((ROOT/f'{kind}.{mode}.verification.json').read_text());s=sem['samples'][kind][mode]
  rows[mode]={'strict_verification_status':v['status'],'strict_checks':v['checks'],'semantic_status':s['status'],'semantic_check_file':'semantic-results.json','semantic_failed_names':[c['name'] for c in s['checks'] if not c['passed']],'diagnostic_xml_hash_failures':[c['name'] for c in v['checks'] if not c['passed'] and c['name'].endswith(('_layout_xml','_master_xml'))],'basic_text_page_order_picture_passed':all(c['passed'] for c in v['checks'] if c['name'] in ['slide_count','slide_dimensions'] or c['name'].endswith(('_texts_and_order','_images_bytes_and_position'))),'notes_preserved':all(c['passed'] for c in v['checks'] if c['name'].endswith('_notes') or c['name']=='zip_notes_part_count'),'table_content_preserved':all(c['passed'] for c in v['checks'] if c['name'].endswith('_tables')),'chart_content_preserved':all(c['passed'] for c in v['checks'] if c['name'].endswith('_charts'))}
 result['samples'][kind]={'status':'limited' if kind=='simple' else 'failed','sdk_steps':r['steps'],'sdk_checks':r['checks'],'edit_locator':r.get('editLocator'),'candidates':r['candidates'],'original':r['original'],'chains':rows,'original_checksum_unchanged':hashlib.sha256((ROOT/Path(m['samples'][kind]['path'])).read_bytes()).hexdigest()==m['samples'][kind]['sha256'],'product_aggregate_unchanged_byte_identical':next(x['sha256'] for x in r['candidates'] if x['mode']=='product-unchanged')==next(x['sha256'] for x in r['candidates'] if x['mode']=='aggregate-unchanged')}
(ROOT/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({'status':result['status'],'sample_status':{k:v['status'] for k,v in result['samples'].items()},'result':str(ROOT/'results.json')},ensure_ascii=False))
