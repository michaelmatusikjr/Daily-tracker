import { parseQuick } from '../js/parse.js';
const T = '2026-11-10'; // Tuesday
const cases = [
 ['Gym 6pm',{title:'Gym',time:'18:00'}], ['Call mom tomorrow 14:30',{title:'Call mom',date:'2026-11-11',time:'14:30'}],
 ['Standup at 9 for 15m',{title:'Standup',time:'09:00',duration:15}], ['Dentist friday 3:30pm for 1h !! #health',{title:'Dentist',date:'2026-11-13',time:'15:30',duration:60,priority:2,tag:'health'}],
 ['Pay rent in 3 days',{date:'2026-11-13',title:'Pay rent'}], ['Read 20 pages',{title:'Read 20 pages',time:null}], ['Call Tom',{title:'Call Tom'}],
 ['Lunch at noon',{time:'12:00',title:'Lunch'}], ['Meeting at 2',{time:'14:00',title:'Meeting'}], ['Party tonight',{time:'20:00',date:T}],
 ['Review on monday at 10am',{date:'2026-11-16',time:'10:00',title:'Review'}],
 ['Gym day after tomorrow',{date:'2026-11-12',title:'Gym'}], ['Monday meeting',{title:'Monday meeting',date:null}],
 ['Sun cream',{title:'Sun cream',date:null}], ['Buy sat nav',{title:'Buy sat nav',date:null}], ['Meeting fri',{date:'2026-11-13',title:'Meeting'}],
 ['Meeting on sat',{date:'2026-11-14',title:'Meeting'}], ['Wake up at 6',{time:'06:00'}], ['Run 6:00',{time:'06:00'}], ['Run at 5',{time:'17:00'}],
 ['Call mom tomorrow, 3pm',{title:'Call mom',date:'2026-11-11',time:'15:00'}], ['Yoga 6p',{time:'18:00',title:'Yoga'}],
 ['Pay 12.50 to Bob',{time:null}], ['Drop by',{title:'Drop by'}], ['On call shift',{title:'On call shift'}], ['Call by 5pm',{title:'Call',time:'17:00'}],
 ['Fix bug #123',{tag:null,title:'Fix bug #123'}], ['Study for 3 hours tomorrow',{duration:180,date:'2026-11-11',title:'Study'}], ['Friday drinks friday',{date:'2026-11-13'}],
 ['Gym monday',{date:'2026-11-16',title:'Gym'}], ['Next friday party',{date:'2026-11-13'}],
 // second QA pass
 ['Pick up kids 3:15',{time:'15:15',title:'Pick up kids'}], ['Call 2:30',{time:'14:30',title:'Call'}], ['9:15 standup',{time:'09:15'}], ['Class 10:30',{time:'10:30'}],
 ['Take 1 a day',{title:'Take 1 a day',time:null}], ['Eat 5 a day',{title:'Eat 5 a day',time:null}],
 ['Prepare for Monday presentation',{title:'Prepare for presentation',date:'2026-11-16'}],
 ['Gym fri #health',{date:'2026-11-13',tag:'health',title:'Gym'}], ['Gym fri !!',{date:'2026-11-13',priority:2}],
 ['Pay 14.50 bill',{time:null,title:'Pay 14.50 bill'}], ['Doctor 10.30',{time:null,title:'Doctor 10.30'}],
 ['Doctor at 10.30',{time:'10:30',title:'Doctor'}], ['Doctor friday 10.30',{time:'10:30',date:'2026-11-13',title:'Doctor'}], ['Dinner 18.30',{time:null}],
 ['Monday gym 6pm',{date:'2026-11-16',time:'18:00',title:'gym'}], ['Wednesday 9am standup',{date:'2026-11-11',time:'09:00',title:'standup'}],
 ['Monday: gym',{date:'2026-11-16',title:'gym'}], ['Monday, gym',{date:'2026-11-16',title:'gym'}], ['Monday',{date:'2026-11-16'}],
 ['Friday drinks',{title:'Friday drinks',date:null}], ['Dinner at 7',{time:'19:00'}], ['Drinks with Sam at 8',{time:'20:00'}],
 ['Movie at 9',{time:'21:00'}], ['Go to bed at 11',{time:'23:00',title:'Go to bed'}], ['Make bed at 8',{time:'08:00',title:'Make bed'}], ['Change bed sheets at 9',{time:'09:00'}], ['Night shift at 7',{time:'19:00'}], ['Go to sleep at 10',{time:'22:00'}], ['Sleep in at 9',{time:'09:00'}], ['Bedtime at 10',{time:'22:00'}], ['Sleep at 10',{time:'22:00'}], ['Night walk at 9',{time:'21:00'}], ['Standup at 8',{time:'08:00'}], ['Date night at 7 friday',{time:'19:00',date:'2026-11-13'}],
];
let fail = 0;
for (const [s, exp] of cases) { const r = parseQuick(s, T); const bad = Object.entries(exp).filter(([k, v]) => r[k] !== v); if (bad.length) { fail++; console.log('FAIL', s, JSON.stringify(r), JSON.stringify(exp)); } }
// drop-guess options
const g1 = parseQuick('Call mom tomorrow 3pm', T, { noDate: true });
if (g1.date !== null || g1.title !== 'Call mom tomorrow' || g1.time !== '15:00') { fail++; console.log('FAIL noDate', JSON.stringify(g1)); }
const g2 = parseQuick('Read Catch-22 at 9', T, { noTime: true });
if (g2.time !== null || g2.title !== 'Read Catch-22 at 9') { fail++; console.log('FAIL noTime', JSON.stringify(g2)); }
const g3 = parseQuick('Monday gym 6pm', T, { noTime: true });
if (g3.date !== '2026-11-16' || g3.time !== null || g3.title !== 'gym 6pm') { fail++; console.log('FAIL noTime keeps leading weekday date', JSON.stringify(g3)); }
const g4 = parseQuick('Wednesday 9am standup', T, { noTime: true });
if (g4.date !== '2026-11-11' || g4.title !== '9am standup') { fail++; console.log('FAIL g4', JSON.stringify(g4)); }
const g5 = parseQuick('Monday gym 6pm', T, { noDate: true });
if (g5.date !== null || g5.time !== '18:00' || g5.title !== 'Monday gym') { fail++; console.log('FAIL g5', JSON.stringify(g5)); }
console.log(fail ? fail + ' failures' : `all ${cases.length + 5} parse cases pass`);
