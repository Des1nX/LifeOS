// Deterministic, realistic LifeOS state used by the smoke tests and baseline screenshots.
// Record shapes mirror what the app's own forms create (see the `fields` objects in each
// open*Form save handler); fixed ids make round-trip/ID checks exact. All dates are relative
// to the frozen test clock (TODAY).
export const TODAY = '2026-09-23'; // Wednesday
export const NOW = new Date(`${TODAY}T10:00:00`).getTime();

const d = off => { const x = new Date(`${TODAY}T00:00`); x.setDate(x.getDate() + off); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const ts = off => NOW + off * 86400000;
const days = (from, to) => { const r = []; for (let i = from; i <= to; i++) r.push(d(i)); return r; };

export function fixtureState() {
  return {
    profile: { name: 'Tester', avatar: '🦸', createdAt: ts(-40) },
    totalXp: 1234,
    xpLog: [
      { id: 'xp1', amount: 1000, reason: 'Imported history', ts: ts(-30), key: 'fixture:history' },
      { id: 'xp2', amount: 200, reason: 'Task: Old task', ts: ts(-2), key: 'task:t_old:' + d(-2) },
      { id: 'xp3', amount: 34, reason: 'Habit: Read', ts: ts(0), key: 'habit:h_read:' + d(0) },
    ],
    attrs: { STR: 120, INT: 80, DEX: 150, VIT: 60, WIS: 40, FOC: 90, SOC: 20 },
    tasks: [
      { id: 't_open', title: 'Write report', description: 'Q3 summary', category: 'Work', priority: 'High', dueDate: d(0), done: false, createdAt: ts(-1), goalId: 'g_fit', xpReward: 30 },
      { id: 't_med', title: 'Buy groceries', description: '', category: 'Personal', priority: 'Medium', dueDate: d(0), done: false, createdAt: ts(-1) },
      { id: 't_done', title: 'Call mom', description: '', category: 'Social', priority: 'Low', dueDate: d(0), done: true, createdAt: ts(-3) },
      { id: 't_old', title: 'Old task', description: '', category: 'Work', priority: 'Urgent', dueDate: d(-2), done: true, createdAt: ts(-5) },
      { id: 't_future', title: 'Dentist', description: '', category: 'Health', priority: 'Medium', dueDate: d(5), done: false, createdAt: ts(-1) },
    ],
    habits: [
      { id: 'h_read', name: 'Read', description: '', icon: '📚', color: '', category: 'Learning', type: 'good', frequency: 'daily', target: 1, weekdays: [], reminder: '', xpReward: 15, attrReward: 'INT', startDate: d(-30), active: true, goalId: '', completions: days(-9, 0), brokenDates: [], createdAt: ts(-30) },
      { id: 'h_water', name: 'Drink water', description: '', icon: '💧', color: '', category: 'Health', type: 'good', frequency: 'daily', target: 8, weekdays: [], reminder: '08:00', xpReward: 15, attrReward: 'VIT', startDate: d(-30), active: true, goalId: 'g_fit', completions: [d(-1), d(-1), d(-1), d(-1), d(-1), d(-1), d(-1), d(-1), d(0), d(0), d(0)], brokenDates: [], createdAt: ts(-30) },
      { id: 'h_smoke', name: 'No smoking', description: '', icon: '🚭', color: '', category: 'Health', type: 'bad', frequency: 'daily', target: 1, weekdays: [], reminder: '', xpReward: 15, attrReward: 'VIT', startDate: d(-30), active: true, goalId: '', completions: days(-6, -1), brokenDates: [d(-7)], createdAt: ts(-30) },
      { id: 'h_gym', name: 'Gym', description: '', icon: '🏋️', color: '', category: 'Fitness', type: 'good', frequency: 'weekly', target: 3, weekdays: [], reminder: '', xpReward: 15, attrReward: 'STR', startDate: d(-30), active: true, goalId: '', completions: [d(-2), d(-5)], brokenDates: [], createdAt: ts(-30) },
    ],
    goals: [
      { id: 'g_fit', title: 'Get in shape', description: '3 months of training', targetDate: d(60), status: 'Active', manualProgress: 30, createdAt: ts(-30), category: 'Fitness' },
      { id: 'g_done', title: 'Read 5 books', description: '', targetDate: d(-10), status: 'Completed', manualProgress: 100, createdAt: ts(-90) },
    ],
    milestones: [
      { id: 'm1', goalId: 'g_fit', title: 'Run 5 km', description: '', completed: true, completedAt: ts(-5), xpReward: 25 },
      { id: 'm2', goalId: 'g_fit', title: 'Run 10 km', description: '', completed: false, completedAt: null, xpReward: 50 },
    ],
    expenses: [
      { id: 'e1', amount: 420, category: 'Food', description: 'Groceries', date: d(0), paymentMethod: 'Card', tags: ['home'], recurring: false, createdAt: ts(0) },
      { id: 'e2', amount: 1200, category: 'Transport', description: 'Fuel', date: d(-3), paymentMethod: 'Card', tags: [], recurring: false, createdAt: ts(-3) },
    ],
    income: [{ id: 'i1', amount: 42000, category: 'Salary', description: 'September', date: d(-8), paymentMethod: 'Bank', tags: [], recurring: true, createdAt: ts(-8) }],
    budgets: [{ id: 'b1', category: 'Food', amount: 6000, period: 'Monthly', createdAt: ts(-20) }],
    financeXpDate: null,
    schemaVersion: 8,
    workouts: [
      { id: 'w1', name: 'Push day', date: d(-2), duration: '60', notes: '', createdAt: ts(-2), exercises: [
        { id: 'ex1', name: 'Bench press', sets: '4', reps: '8', weight: '80', muscle: 'Chest', rpe: '8', rest: '120' },
        { id: 'ex2', name: 'Overhead press', sets: '3', reps: '10', weight: '45', muscle: 'Shoulders', rpe: '', rest: '' }] },
      { id: 'w2', name: 'Pull day', date: d(0), duration: '50', notes: 'Felt good', createdAt: ts(0), exercises: [
        { id: 'ex3', name: 'Deadlift', sets: '3', reps: '5', weight: '140', muscle: 'Back', rpe: '9', rest: '180' }] },
    ],
    meals: [
      { id: 'meal1', name: 'Oatmeal', type: 'Breakfast', date: d(0), calories: '450', protein: '20', carbs: '60', fat: '12', servings: 1, notes: '', createdAt: ts(0) },
      { id: 'meal2', name: 'Chicken & rice', type: 'Lunch', date: d(0), calories: '700', protein: '55', carbs: '80', fat: '15', servings: 1, notes: '', createdAt: ts(0) },
    ],
    waterLog: [{ id: 'wa1', date: d(0), amount: 250 }, { id: 'wa2', date: d(0), amount: 250 }],
    nutritionTargets: { calories: 2400, protein: 160, carbs: 250, fat: 70, water: 2500 },
    customFoods: [{ id: 'cf1', name: 'Protein shake', calories: 200, protein: 30, carbs: 8, fat: 3, favorite: true }],
    recipes: [],
    notes: [
      { id: 'n1', title: 'Ideas', body: 'Side project ideas', category: 'Personal', tags: ['ideas'], pinned: true, favorite: false, createdAt: ts(-4), updatedAt: ts(-1) },
      { id: 'n2', title: 'Meeting', body: 'Agenda for Monday', category: 'Work', tags: [], pinned: false, favorite: true, createdAt: ts(-2), updatedAt: ts(-2) },
    ],
    journal: [{ id: 'j1', date: d(-1), mood: '🙂', rating: '4', text: 'Productive day.', tags: ['work'], createdAt: ts(-1) }],
    vehicles: [{ id: 'v1', name: 'Octavia', brand: 'Škoda', model: 'Octavia', year: '2019', mileage: '84000', vin: '', regExpiry: d(20), insuranceExpiry: d(200), createdAt: ts(-60) }],
    carServices: [{ id: 'cs1', vehicleId: 'v1', type: 'Oil change', date: d(-40), mileage: '80000', cost: '2500', notes: '', createdAt: ts(-40) }],
    fuelEntries: [
      { id: 'fu1', vehicleId: 'v1', date: d(-20), liters: '45', total: '1750', mileage: '83000', station: 'Shell', createdAt: ts(-20) },
      { id: 'fu2', vehicleId: 'v1', date: d(-3), liters: '42', total: '1650', mileage: '83700', station: 'OMV', createdAt: ts(-3) },
    ],
    subscriptions: [
      { id: 's1', name: 'Spotify', price: 169, period: 'Monthly', nextPayment: d(4), category: 'Entertainment', notes: '', active: true, createdAt: ts(-100) },
      { id: 's2', name: 'iCloud', price: 790, period: 'Yearly', nextPayment: d(120), category: 'Cloud', notes: '', active: true, createdAt: ts(-100) },
    ],
    events: [
      { id: 'ev1', title: 'Team meeting', description: '', date: d(0), category: 'Work', start: '14:00', end: '15:00', location: 'Office', recurring: 'weekly', reminder: '', linkedTaskId: 't_open', linkedGoalId: '', linkedHabitId: '', createdAt: ts(-10) },
      { id: 'ev2', title: 'Birthday', description: '', date: d(3), category: 'Personal', start: '', end: '', location: '', recurring: 'none', reminder: '', linkedTaskId: '', linkedGoalId: '', linkedHabitId: '', createdAt: ts(-10) },
    ],
    quests: [], questResetDate: null,
    sleepLog: [
      { id: 'sl1', date: d(-1), bedtime: '23:00', wake: '07:00', quality: '4', notes: '', createdAt: ts(-1) },
      { id: 'sl2', date: d(0), bedtime: '23:30', wake: '06:45', quality: '3', notes: 'Woke up once', createdAt: ts(0) },
    ],
    weightLog: [{ id: 'wt1', date: d(-7), weight: 82.4, unit: 'kg', createdAt: ts(-7) }, { id: 'wt2', date: d(0), weight: 81.6, unit: 'kg', createdAt: ts(0) }],
    stepsLog: [{ id: 'st1', date: d(-1), steps: 9500, createdAt: ts(-1) }, { id: 'st2', date: d(0), steps: 4300, createdAt: ts(0) }],
    heartRateLog: [{ id: 'hr1', date: d(0), value: 62, type: 'resting', createdAt: ts(0) }],
    activeCaloriesLog: [{ id: 'ac1', date: d(0), calories: 380, createdAt: ts(0) }],
    achievementsUnlocked: ['first_task'],
    achievementUnlockedAt: { first_task: ts(-30) },
    rpg: {
      // totalXp 1234 = level 4 (100+255+441 spent, 438/652 into level 4) -> 3 levels rewarded.
      skillPoints: { available: 2, earned: 3, spent: 1 },
      attributePoints: { available: 5, earned: 9, spent: 4 },
      highestLevelRewarded: 4,
      skillTree: { unlocked: ['discipline_consistency_1'], totalSpent: 1 },
      activityLog: [{ id: 'al1', type: 'levelup', title: 'Level 4', description: 'Reached Level 4', xp: 0, createdAt: ts(-5) }],
    },
    dailyTargets: { workoutsPerWeek: 3, tasksPerDay: 3, habitsPerDay: 2 },
    notificationLog: [],
    settings: {
      theme: 'dark', onboarded: true, language: 'cs', dateFormat: 'DD.MM.YYYY', timeFormat: '24h', firstDayOfWeek: 'monday',
      animations: true, sounds: false,
      notifications: { task: true, event: true, habit: true, goal: true, subscription: true, car: true, quest: true, achievement: true, levelup: true },
      notificationsPermission: 'default',
    },
  };
}
