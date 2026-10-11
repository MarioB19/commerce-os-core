#!/usr/bin/env python3
"""Deterministic synthetic catalog and PDFs; no commercial source is read."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1] / 'portals' / 'mi-ciclo-listo'
FIELDS = ['Lenguajes', 'Saberes y Pensamiento Científico', 'Ética, Naturaleza y Sociedades', 'De lo Humano y lo Comunitario']
PDF_NAMES = ['mi-ciclo-listo-paquete-completo.pdf', 'bono-01-primera-semana-lista.pdf',
             'bono-02-instrumentos-evaluacion-observacion.pdf', 'bono-03-kit-cte-control-grupo.pdf',
             'bono-04-banco-dinamicas.pdf', 'bono-05-proyectos-temporada.pdf',
             'bono-06-adecuaciones-diversidad-aula.pdf', 'bono-07-cartas-comunicados-familias.pdf',
             'bono-08-material-recortable-aula.pdf', 'calendario-del-ciclo.pdf']

def sha(data):
    return hashlib.sha256(data).hexdigest()

def pdf(number):
    stream = f'BT /F1 16 Tf 50 740 Td (SYNTHETIC PUBLIC TEST FIXTURE {number:02}) Tj 0 -30 Td (No commercial or customer content.) Tj ET\n'.encode()
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
               b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'endstream']
    data = b'%PDF-1.4\n'; offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data)); data += str(i).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
    start = len(data); data += b'xref\n0 6\n0000000000 65535 f \n'
    data += b''.join(f'{offset:010} 00000 n \n'.encode() for offset in offsets[1:])
    return data + f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode()

def write_json(relative, value):
    target = ROOT / relative; target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    return target

def generate():
    activities = []; grades = []
    for level, count, each in [('preescolar', 3, 120), ('primaria', 6, 20)]:
        for grade in range(1, count + 1):
            gid = f'{level}-{grade}'; label = f'{grade}.º de {level}'
            sample = f'synthetic-{gid}-001'
            for index in range(1, each + 1):
                activity = {'id': f'synthetic-{gid}-{index:03}', 'nivel': level, 'grado': label,
                    'campo': FIELDS[(index - 1) % 4], 'titulo': f'Fixture sintético {gid} {index:03}',
                    'eje': 'Prueba sintética', 'duracion': '1 minuto', 'modalidad': 'Prueba',
                    'proposito': 'Comprobar el software con datos inventados para pruebas.',
                    'observacion': 'Sin información de personas ni contenido comercial.',
                    'materiales': ['Dato sintético'], 'pasos': ['Preparar la prueba.', 'Ejecutar la prueba.', 'Verificar el resultado.'],
                    'sugerencia': 'Fixture de software; no es material pedagógico.',
                    'fuente': 'Generador público determinista de fixtures', 'revisionPedagogica': 'PENDIENTE'}
                activities.append(activity)
            grades.append({'id': gid, 'label': label, 'level': level, 'grade': grade, 'activityCount': each,
                'sampleId': sample, 'pdfSlug': 'paquete-completo', 'fields': {field: each // 4 for field in FIELDS}})
    catalog = write_json('data/activities.json', activities)
    write_json('data/primary-activities.json', [x for x in activities if x['nivel'] == 'primaria'])
    write_json('editorial/preschool-original.json', [x for x in activities if x['nivel'] == 'preescolar'])
    write_json('data/catalog-manifest.json', {'version': 'synthetic-public-v1', 'totalActivities': 480,
        'preschoolActivities': 360, 'primaryActivities': 120, 'pedagogicalReview': 'NOT_APPLICABLE_SYNTHETIC',
        'reviewer': None, 'grades': grades, 'catalogSha256': sha(catalog.read_bytes())})
    pdfs = []
    for index, name in enumerate(PDF_NAMES, 1):
        target = ROOT / 'private/pdfs' / name; target.parent.mkdir(parents=True, exist_ok=True)
        data = pdf(index); target.write_bytes(data)
        pdfs.append({'file': name, 'bytes': len(data), 'pages': 1, 'sha256': sha(data)})
    write_json('data/pdf-manifest.json', pdfs)
    write_json('data/commerce-os-product-manifest.json', {'schemaVersion': 2, 'productVersion': 'synthetic-public-v1',
        'displayName': 'Synthetic portal verification fixture', 'state': 'SYNTHETIC_TEST_ONLY',
        'editorialApproval': 'NOT_APPLICABLE_SYNTHETIC', 'pedagogicalApproval': 'NOT_APPLICABLE_SYNTHETIC',
        'phoneVerification': 'NOT_PERFORMED', 'deployment': 'FORBIDDEN_SYNTHETIC_PORTAL',
        'counts': {'activities': 480, 'preschoolActivities': 360, 'primaryActivities': 120, 'grades': 9,
                   'coreDownloads': 9, 'privatePdfs': 10, 'primaryGradeWorkbooks': 0, 'primaryBonusSupplements': 0, 'unifiedBonuses': 8},
        'pricingMxnCents': {'referencePrice': 1, 'positivePaymentUnlocksAll': True, 'minimumUnlockAmount': 1},
        'method': 'Deterministic synthetic software fixture', 'grades': grades,
        'catalog': {'sourcePath': 'data/activities.json', 'sha256': sha(catalog.read_bytes())},
        'corePdfs': [{'slug': 'paquete-completo' if index == 0 else f'bono-{index}', 'scope': 'core',
            'sourcePath': 'private/pdfs/' + row['file'], **row} for index, row in enumerate(pdfs[:9])],
        'calendarPdf': {'sourcePath': 'private/pdfs/' + pdfs[-1]['file'], **pdfs[-1], 'delivery': 'SYNTHETIC_TEST_ONLY', 'exposedInPortal': False},
        'restrictions': ['No real content', 'No real customers', 'Not permitted for portal deployment']})
    files = ['data/activities.json', 'data/primary-activities.json', 'editorial/preschool-original.json',
             'data/catalog-manifest.json', 'data/pdf-manifest.json', 'data/commerce-os-product-manifest.json']
    files += ['private/pdfs/' + name for name in PDF_NAMES]
    write_json('PUBLIC_FIXTURE_PROFILE.json', {'schema_version': 1, 'profile': 'synthetic-public-v1',
        'production_portal_installation': 'FORBIDDEN', 'activities': 480, 'pdfs': 10,
        'files': {name: sha((ROOT / name).read_bytes()) for name in files}})

if __name__ == '__main__':
    generate()
    print('Synthetic portal fixtures generated: 480 activities, 10 PDFs; production installation forbidden.')
